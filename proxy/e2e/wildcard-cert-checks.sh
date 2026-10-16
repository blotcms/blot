#!/usr/bin/env bash
#
# The wildcard certificate (proxy/config/wildcard_cert.lua): served from Redis
# when it is there, with no reload, and the file otherwise. Run by the
# proxy-behaviour job in .github/workflows/integration.yml, after the other
# checks, against:
#
#   - the proxy container (BLOT_HOST=localhost), with the image's self-signed
#     placeholder as the certificate file
#   - a Redis 6.2 container sharing the proxy's network namespace, so the
#     proxy's default Redis host (127.0.0.1) reaches it. It must not be
#     started before this script.
#
# Environment: PROXY_HTTPS_HOST (host:port of the proxy's TLS port, default
# 127.0.0.1:8443), and optionally PROXY_CONTAINER / REDIS_CONTAINER if not named proxy / redis.
# No pipefail: `docker logs ... | grep -q` would fail on the SIGPIPE grep
# sends when it stops reading at the first match.
set -eu

# Seconds between the proxy's reads of Redis: INTERVAL in
# proxy/config/wildcard_cert.lua. Keep the two in step.
INTERVAL=10
CONNECT=${PROXY_HTTPS_HOST:-127.0.0.1:8443}
PROXY=${PROXY_CONTAINER:-proxy}
REDIS=${REDIS_CONTAINER:-redis}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# the failed-read backoff in wildcard_cert.lua, plus the TTL, plus slack
WAIT=$((INTERVAL + 20))

redis() { docker exec -i "$REDIS" redis-cli "$@"; }

make_cert() { # make_cert <name>: $WORK/<name>.pem and .key, CN=<name>
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -days 2 -subj "/CN=$1" -addext "subjectAltName=DNS:localhost,DNS:*.localhost" \
    -keyout "$WORK/$1.key" -out "$WORK/$1.pem" 2>/dev/null
}

put_cert() { # put_cert <name>
  redis -x set blot:openresty:ssl:key < "$WORK/$1.key" >/dev/null
  redis -x set blot:openresty:ssl:pem < "$WORK/$1.pem" >/dev/null
}

served_subject() { # served_subject <sni>
  echo | timeout 15 openssl s_client -connect "$CONNECT" -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null || true
}

# Waits for $1 to be presented for SNI $2, the way the proxy would after its
# cache or backoff expires
wait_for() { # wait_for <CN> <sni>
  local i subject
  for i in $(seq 1 "$WAIT"); do
    subject=$(served_subject "$2")
    case "$subject" in *"$1"*) echo "  ok  - $2 serves $1 (after ${i}s)"; return 0 ;; esac
    sleep 1
  done
  echo "  FAIL - $2 does not serve $1 (got '$subject')" >&2
  docker logs --tail 30 "$PROXY" >&2 || true
  exit 1
}

make_cert wildcard-a
make_cert wildcard-b

echo "no Redis: the certificate file is served"
wait_for blot-proxy-placeholder localhost
wait_for blot-proxy-placeholder anything.localhost

echo "a certificate put in Redis is served without a reload"
docker run -d --name "$REDIS" --network "container:$PROXY" redis:6.2.12-alpine >/dev/null
for _ in $(seq 1 30); do
  [ "$(redis ping 2>/dev/null || true)" = PONG ] && break
  sleep 1
done
put_cert wildcard-a
wait_for wildcard-a localhost
wait_for wildcard-a anything.localhost
wait_for wildcard-a preview-of-anything.localhost
wait_for wildcard-a cdn.localhost

echo "a renewed certificate replaces it once the cache expires"
put_cert wildcard-b
wait_for wildcard-b anything.localhost

echo "a custom domain is not affected"
subject=$(served_subject someblog.example)
echo "  someblog.example: $subject"
case "$subject" in *wildcard-*) echo "  FAIL - custom domain got a wildcard certificate" >&2; exit 1 ;; esac

echo "a certificate that does not parse is logged and the last good one keeps being served"
redis set blot:openresty:ssl:pem "not a certificate" >/dev/null
for _ in $(seq 1 "$WAIT"); do
  docker logs "$PROXY" 2>&1 | grep -q "wildcard cert: the certificate does not parse" && break
  served_subject anything.localhost >/dev/null
  sleep 1
done
docker logs "$PROXY" 2>&1 | grep -q "wildcard cert: the certificate does not parse"
case "$(served_subject anything.localhost)" in
  *wildcard-b*) echo "  ok  - still serving wildcard-b" ;;
  *) echo "  FAIL - did not keep the last good certificate" >&2; exit 1 ;;
esac

echo "missing keys fall back to the file"
put_cert wildcard-a
wait_for wildcard-a anything.localhost
redis del blot:openresty:ssl:pem blot:openresty:ssl:key >/dev/null
wait_for blot-proxy-placeholder anything.localhost

echo "Redis stopped: the last certificate read keeps being served, quickly"
put_cert wildcard-a
wait_for wildcard-a anything.localhost
docker stop "$REDIS" >/dev/null
sleep $((INTERVAL + 2))
start=$(date +%s)
subject=$(served_subject anything.localhost)
elapsed=$(( $(date +%s) - start ))
echo "  anything.localhost: $subject (${elapsed}s)"
case "$subject" in *wildcard-a*) ;; *) echo "  FAIL - lost the certificate while Redis was down" >&2; exit 1 ;; esac
[ "$elapsed" -lt 5 ]
docker logs "$PROXY" 2>&1 | grep -q "wildcard cert: cannot connect to redis"

echo "wildcard certificate checks passed"
