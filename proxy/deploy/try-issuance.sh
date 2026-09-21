#!/usr/bin/env bash
#
# Issue a certificate through the proxy image from Let's Encrypt STAGING, for a
# throwaway domain, without touching what is serving. Run it on the production
# host, before a cutover or blue-green deploy:
#
#   proxy/deploy/try-issuance.sh <commit-sha | image> <throwaway-domain>
#
# This is the one check that exercises the image's ACME client (dehydrated),
# its CA trust and the hook server against a real ACME server. CI can only use
# Pebble.
#
# The domain must be one nobody uses (a subdomain of a domain you own is
# fine), with DNS pointing at this host so that Let's Encrypt's HTTP-01 request
# reaches port 80 here. That request is answered by whichever proxy is serving:
# lua-resty-auto-ssl keeps challenge tokens in Redis, which the throwaway
# container writes to. The container itself listens only on 127.0.0.1:18444
# (a Docker bridge, its own auto-ssl volume, no cache or logs), so nothing
# user-facing changes.
#
# Writes domain:<domain> to Redis for the duration (so the container allows
# the domain) and removes it, and the staging certificate, when it exits.
# Refuses a domain that already has either key.
set -euo pipefail

IMAGE_ARG="${1:?usage: try-issuance.sh <commit-sha | image> <throwaway-domain>}"
DOMAIN="${2:?usage: try-issuance.sh <commit-sha | image> <throwaway-domain>}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$DIR/common.sh"

STAGING_CA="${PROXY_STAGING_CA:-https://acme-staging-v02.api.letsencrypt.org/directory}"
NAME=blot-proxy-issuance
PORT=18444
ATTEMPTS="${PROXY_ISSUANCE_ATTEMPTS:-40}"

IMAGE="$(resolve_image "$IMAGE_ARG")"
load_env
acquire_lock
command -v redis-cli >/dev/null 2>&1 || die "redis-cli is not installed"

case "$DOMAIN" in
  *.*) ;;
  *) die "$DOMAIN is not a domain" ;;
esac
case "$DOMAIN" in
  "$BLOT_HOST"|*."$BLOT_HOST") die "$DOMAIN is under $BLOT_HOST: use a separate throwaway domain" ;;
esac
for key in "domain:$DOMAIN" "ssl:$DOMAIN:latest"; do
  [ "$(redis-cli -h "$REDIS_HOST" exists "$key")" = 0 ] \
    || die "Redis already has $key: this is not a throwaway domain, refusing"
done

cleanup() {
  local status=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  redis-cli -h "$REDIS_HOST" del "domain:$DOMAIN" "ssl:$DOMAIN:latest" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ensure_image "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
redis-cli -h "$REDIS_HOST" set "domain:$DOMAIN" 1 >/dev/null

log "Starting $NAME from $IMAGE with PROXY_ACME_CA=$STAGING_CA"
# -e comes after --env-file, so it wins. No auto-ssl, cache or log volumes.
docker run -d --name "$NAME" --cap-add SYS_NICE \
  --env-file "$ENV_FILE" \
  -e PROXY_ACME_CA="$STAGING_CA" \
  -e PROXY_FETCH_CDN_IPS=false \
  -e PROXY_PRIVATE_IP=127.0.0.1 \
  -p "127.0.0.1:$PORT:443" \
  -v "$CERT_DIR":/etc/ssl/private:ro \
  "$IMAGE" >/dev/null
wait_healthy "$NAME" "$HEALTH_TIMEOUT" \
  || { docker logs --tail 50 "$NAME" >&2 || true; die "$NAME did not become healthy"; }

issuer=""
for i in $(seq 1 "$ATTEMPTS"); do
  issuer=$(echo | timeout 10 openssl s_client -connect "$SITE_IP:$PORT" -servername "$DOMAIN" 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null || true)
  log "attempt $i/$ATTEMPTS: ${issuer:-no certificate}"
  case "$issuer" in *STAGING*) break ;; esac
  nap 3
done

case "$issuer" in
  *STAGING*)
    log "Issued by Let's Encrypt staging: the image's dehydrated, CA trust and hook server work against a real ACME server."
    ;;
  *)
    docker logs --tail 80 "$NAME" >&2 || true
    die "no staging certificate was issued for $DOMAIN (does its DNS point at this host, and is port 80 open?)"
    ;;
esac
