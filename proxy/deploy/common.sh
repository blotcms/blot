#!/usr/bin/env bash
#
# Shared by blue-green.sh and cutover-from-baremetal.sh. Source it, do not run
# it. Everything here runs ON the production host (copy proxy/deploy/ across,
# or run it in place from a checkout):
#
#   scp -r proxy/deploy blot:~/proxy-deploy
#
# Settings come from the environment, with these defaults for production:
#
#   PROXY_ENV_FILE         /etc/blot/proxy.env  docker --env-file for the proxy
#                                               (see proxy.env.example)
#   PROXY_CACHE_DIR        /var/instance-ssd/cache  the same disk cache the
#                                               bare-metal OpenResty uses
#   PROXY_LOG_DIR          /var/instance-ssd/logs   fail2ban and logrotate
#                                               read the access log here
#   PROXY_CERT_DIR         /etc/ssl/private     wildcard cert + key (read-only)
#   PROXY_AUTOSSL_VOLUME   blot-proxy-auto-ssl  dehydrated account state
#   PROXY_NODE_CONTAINER   blot-container-blue  a Node container to purge from
#   PROXY_PURGE_URLS       (read from $PROXY_NODE_CONTAINER's environment)  comma separated
#   PROXY_CANARY_HOST      preview-of-wireframe-on-david.<BLOT_HOST>
#   PROXY_REGISTRY_URL     ghcr.io/blotcms/blot-proxy  for a bare tag / commit SHA
#   PROXY_HEALTH_TIMEOUT   60                   seconds to wait for a new container
#   PROXY_DRAIN_TIMEOUT    30                   seconds an old container may drain
#   PROXY_DEPLOY_LOCK      /tmp/blot-proxy-deploy.lock  held by every deploy script
#   PROXY_SKIP_CERT_SWEEP  (unset)              1 skips the custom-domain certificate
#                                               comparison (see cert_baseline)
#
# PROXY_DEPLOY_SLEEP replaces `sleep` (the tests set it to a no-op).

ENV_FILE="${PROXY_ENV_FILE:-/etc/blot/proxy.env}"
CACHE_DIR="${PROXY_CACHE_DIR:-/var/instance-ssd/cache}"
LOG_DIR="${PROXY_LOG_DIR:-/var/instance-ssd/logs}"
CERT_DIR="${PROXY_CERT_DIR:-/etc/ssl/private}"
AUTOSSL_VOLUME="${PROXY_AUTOSSL_VOLUME:-blot-proxy-auto-ssl}"
NODE_CONTAINER="${PROXY_NODE_CONTAINER:-blot-container-blue}"
HEALTH_TIMEOUT="${PROXY_HEALTH_TIMEOUT:-60}"
DRAIN_TIMEOUT="${PROXY_DRAIN_TIMEOUT:-30}"
HEALTH_SOCK="/run/openresty/health.sock"
LOCK_FILE="${PROXY_DEPLOY_LOCK:-/tmp/blot-proxy-deploy.lock}"
SITE_IP="127.0.0.1"

# Never fail because the terminal went away: the cutover ignores SIGPIPE and
# must still be able to finish and roll back with nobody watching.
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" 2>/dev/null || true; }
die() { log "ERROR: $*" >&2; exit 1; }
nap() { ${PROXY_DEPLOY_SLEEP:-sleep} "$1"; }

# Commands which need root (systemctl). The deploy user has passwordless sudo;
# fail early and clearly rather than hanging on a prompt mid-cutover.
sys() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}

# One deploy at a time on this host: two scripts would pick the same colours
# and remove each other's containers. Held (fd 9) until the script exits.
acquire_lock() {
  exec 9>>"$LOCK_FILE" || die "cannot open the deploy lock $LOCK_FILE"
  chmod 666 "$LOCK_FILE" 2>/dev/null || true
  flock -n 9 || die "another proxy deploy is already running on this host (lock $LOCK_FILE)"
}

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }
exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }

env_value() { # env_value <file> <NAME> - last assignment, quotes and `export` stripped
  grep -E "^(export )?$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "'\""
}

load_env() {
  [ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (see proxy/deploy/proxy.env.example)"
  BLOT_HOST="$(env_value "$ENV_FILE" BLOT_HOST)"
  [ -n "$BLOT_HOST" ] || die "BLOT_HOST is not set in $ENV_FILE"
  # An empty value in an --env-file overrides the image's default, which
  # would render an empty Redis host into the certificate adapter.
  REDIS_HOST="$(env_value "$ENV_FILE" PROXY_REDIS_HOST)"
  [ -n "$REDIS_HOST" ] || die "PROXY_REDIS_HOST is not set in $ENV_FILE"
  # Same for the purge listener: an empty address renders `listen :8077`, which
  # binds the unauthenticated /purge, /inspect and /rehydrate on every interface.
  [ -n "$(env_value "$ENV_FILE" PROXY_PRIVATE_IP)" ] || die "PROXY_PRIVATE_IP is not set in $ENV_FILE"
  CANARY_HOST="${PROXY_CANARY_HOST:-preview-of-wireframe-on-david.$BLOT_HOST}"
}

# A bare tag or commit SHA means the image CI publishes
# (.github/workflows/proxy-image.yml); anything with a / or : is used as given.
PROXY_REGISTRY_URL="${PROXY_REGISTRY_URL:-ghcr.io/blotcms/blot-proxy}"
resolve_image() {
  case "$1" in */*|*:*) echo "$1" ;; *) echo "$PROXY_REGISTRY_URL:$1" ;; esac
}

ensure_image() { # pull only when it is not already on the host
  docker image inspect "$1" >/dev/null 2>&1 || { log "Pulling $1"; docker pull "$1"; }
}

# Arguments common to every real proxy container (not the rehearsal).
# Host networking: the generated upstreams are 127.0.0.1:8088-8090 and the
# Node containers publish those ports on the host.
run_args() { # run_args <name>
  RUN_ARGS=(
    --name "$1"
    --network host
    --cap-add SYS_NICE
    --log-driver json-file --log-opt max-size=512m --log-opt max-file=1
    --env-file "$ENV_FILE"
    -v "$CACHE_DIR":/var/cache/openresty
    -v "$LOG_DIR":/var/log/openresty
    -v "$AUTOSSL_VOLUME":/etc/resty-auto-ssl
    -v "$CERT_DIR":/etc/ssl/private:ro
  )
}

# Render the image's config with this host's settings and have nginx parse it,
# without binding anything. Only the certificate directory is mounted: the
# check must not touch the live cache or logs.
validate_image() { # validate_image <image>
  docker run --rm --entrypoint bash \
    --env-file "$ENV_FILE" -e PROXY_FETCH_CDN_IPS=false \
    -v "$CERT_DIR":/etc/ssl/private:ro \
    "$1" -c 'render-config >/dev/null && /usr/local/openresty/bin/openresty -t' 2>&1
}

# The access log must land in $LOG_DIR: fail2ban and logrotate read it there,
# and the container has no ban layer of its own. Images are built for stdout
# logging by default (LOG_TO_STDOUT=true); a production image needs
# LOG_TO_STDOUT=false.
image_logs_to_file() { # image_logs_to_file <image>
  docker run --rm --entrypoint bash --env-file "$ENV_FILE" \
    -e PROXY_FETCH_CDN_IPS=false "$1" \
    -c 'render-config >/dev/null && grep -Eq "^[[:space:]]*access_log /var/log/openresty/access.log" /usr/local/openresty/nginx/conf/nginx.conf'
}

# The container answers on a per-container Unix socket, so during a blue/green
# overlap the other container cannot answer for it.
healthy() { # healthy <name>
  docker exec "$1" curl -fsS -o /dev/null --unix-socket "$HEALTH_SOCK" http://localhost/health >/dev/null 2>&1
}

wait_healthy() { # wait_healthy <name> <timeout>
  local deadline=$(( $(date +%s) + $2 ))
  while ! healthy "$1"; do
    running "$1" || return 1
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    nap 1
  done
}

# ---- what the outside world sees -------------------------------------------

# HTTP status of a request to this host for <host> on <port> (default 443),
# with the certificate verified against the system CAs, so a placeholder or
# expired certificate fails here.
https_status() { # https_status <host> [path] [port]
  local port="${3:-443}"
  # --connect-to keeps the Host header and SNI as <host> (no :port) whatever
  # port the proxy under test is on
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    --connect-to "$1:443:$SITE_IP:$port" "https://$1${2:-/}" 2>/dev/null || echo 000
}

# The hosts whose answers are compared before and after a change: the site,
# the canary blog and, if PROXY_CUSTOM_DOMAIN is set, a custom domain (whose
# certificate comes from Redis, not the wildcard file).
check_hosts() {
  echo "$BLOT_HOST"
  echo "$CANARY_HOST"
  if [ -n "${PROXY_CUSTOM_DOMAIN:-}" ]; then echo "$PROXY_CUSTOM_DOMAIN"; fi
}

snapshot() { # snapshot [port] -> "host=status host=status ..."
  local h out=""
  for h in $(check_hosts); do out+="$h=$(https_status "$h" / "${1:-443}") "; done
  echo "${out% }"
}

# ---- custom-domain certificates ---------------------------------------------
# lua-resty-auto-ssl keeps one certificate per custom domain in Redis
# (ssl:<domain>:latest). The wildcard file is checked above, but these are the
# certificates customers see, and the ones a broken container would get wrong
# without any of the checked hosts noticing. So ask the proxy for every one of
# them (by SNI) and require the same certificates from the replacement.

custom_cert_domains() {
  redis-cli -h "$REDIS_HOST" --scan --count 1000 --pattern 'ssl:*:latest' \
    | sed -E 's/^ssl:(.*):latest$/\1/' | sort -u
}

# cert_sweep [port] -> sorted "<domain> <sha256 fingerprint | none>" lines
cert_sweep() {
  local port="${1:-443}"
  custom_cert_domains | xargs -r -P 16 -I{} bash -c '
    fp=$(echo | timeout 5 openssl s_client -connect "$1:$2" -servername "$3" 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
    echo "$3 ${fp:-none}"' _ "$SITE_IP" "$port" {} | sort
}

# Every domain that presented a certificate before must present the same one
# now. (A domain with none before is not held against the replacement.)
certs_unchanged() { # certs_unchanged <baseline> <now>
  local bad
  bad=$(comm -23 <(printf '%s\n' "$1" | grep -v ' none$' | sort) <(printf '%s\n' "$2" | sort))
  [ -z "$bad" ] || {
    log "custom-domain certificates changed or went missing ($(printf '%s\n' "$bad" | wc -l | tr -d ' ')): first few, as they were:"
    printf '%s\n' "$bad" | head -5 | while read -r line; do log "  $line"; done
    return 1
  }
}

# Record the certificates the running proxy serves; CERT_BASELINE is what
# live_checks and the rehearsal compare against. Refuses to go on with no
# certificates to compare unless PROXY_SKIP_CERT_SWEEP=1.
cert_baseline() {
  CERT_BASELINE=""
  [ "${PROXY_SKIP_CERT_SWEEP:-}" != 1 ] || { log "PROXY_SKIP_CERT_SWEEP=1: not comparing custom-domain certificates"; return 0; }
  command -v redis-cli >/dev/null 2>&1 \
    || { log "redis-cli is not installed, so custom-domain certificates cannot be compared (PROXY_SKIP_CERT_SWEEP=1 to skip)"; return 1; }
  CERT_BASELINE="$(cert_sweep | sed '/^$/d')"
  local total served
  total=$(printf '%s\n' "$CERT_BASELINE" | sed '/^$/d' | wc -l | tr -d ' ')
  served=$(printf '%s\n' "$CERT_BASELINE" | sed '/^$/d' | grep -vc ' none$' || true)
  [ "$served" -gt 0 ] \
    || { log "no custom-domain certificate could be read from the running proxy ($total in Redis): nothing to compare (PROXY_SKIP_CERT_SWEEP=1 to skip)"; return 1; }
  log "Custom-domain certificates: $served of $total in Redis are being served"
}

all_ok() { ! echo "$1" | tr ' ' '\n' | grep -v '=200$' | grep -q .; }

# The certificate being served must be the file on disk, not the image's
# self-signed placeholder or a stale one.
served_cert_matches_disk() { # served_cert_matches_disk [port]
  local served disk
  served=$(echo | openssl s_client -connect "$SITE_IP:${1:-443}" -servername "$BLOT_HOST" 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null)
  disk=$(openssl x509 -in "$CERT_DIR/letsencrypt-domain.pem" -noout -fingerprint -sha256 2>/dev/null)
  [ -n "$served" ] && [ "$served" = "$disk" ]
}

purge_urls() {
  # From the running container, not the secrets file: the file may have been
  # edited since the container was created, and the app uses what it started with.
  local urls="${PROXY_PURGE_URLS:-$(docker exec "$NODE_CONTAINER" printenv BLOT_REVERSE_PROXY_URLS 2>/dev/null || true)}"
  echo "$urls" | tr ',' '\n' | sed '/^$/d'
}

# Blot purges the proxy cache from inside a Node container, which sits on a
# Docker bridge and cannot see the host's 127.0.0.1. The probe sends the Node
# container's own BLOT_PURGE_TOKEN (as the app does) to the listener's root: an
# authorised request gets the listener's 404, an unreachable address or a
# rejected token (403, a token mismatch between Node and the proxy) fails.
purge_reachable() {
  local url urls
  urls="$(purge_urls)"
  [ -n "$urls" ] || { log "$NODE_CONTAINER has no BLOT_REVERSE_PROXY_URLS (recreate it after editing secrets.env, or set PROXY_PURGE_URLS)"; return 1; }
  while read -r url; do
    docker exec "$NODE_CONTAINER" node -e '
      const u = new URL(process.argv[1]);
      require(u.protocol === "https:" ? "https" : "http")
        .get(u, { timeout: 5000, headers: process.env.BLOT_PURGE_TOKEN
          ? { "X-Blot-Purge-Token": process.env.BLOT_PURGE_TOKEN } : {} },
          (r) => { r.resume(); process.exit(r.statusCode === 404 || r.statusCode === 200 ? 0 : 1); })
        .on("timeout", function () { this.destroy(); process.exit(1); })
        .on("error", () => process.exit(1));
    ' "$url" || { log "purge endpoint $url is not reachable from $NODE_CONTAINER, or rejects its BLOT_PURGE_TOKEN"; return 1; }
  done <<< "$urls"
}

# Redis holds the custom-domain certificates and allowlist; none of the hosts
# checked above needs it, so probe it directly (host networking: the container
# sees what the host sees).
redis_reachable() {
  timeout 5 bash -c "</dev/tcp/$REDIS_HOST/6379" 2>/dev/null \
    || { log "the proxy cannot reach Redis at $REDIS_HOST:6379"; return 1; }
}

# The webhook route goes straight to the master upstream (PROXY_UPSTREAM_GREEN)
# and no checked host exercises it, so probe every configured upstream.
upstreams_reachable() {
  local var default addr
  for var in BLUE:127.0.0.1:8088 GREEN:127.0.0.1:8089 YELLOW:127.0.0.1:8090; do
    default="${var#*:}"
    addr="$(env_value "$ENV_FILE" "PROXY_UPSTREAM_${var%%:*}")"
    addr="${addr:-$default}"
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$addr/health" || true)" = 200 ] \
      || { log "upstream $addr (PROXY_UPSTREAM_${var%%:*}) is not healthy"; return 1; }
  done
}

# Every checked host answers as it did before ($1, from snapshot; empty = no
# baseline, so every host must answer 200), the certificate served is the one
# on disk, every custom-domain certificate is the one served before
# (CERT_BASELINE, when set), Node can still reach the purge endpoint, and
# Redis and every upstream are reachable.
live_checks() { # live_checks <expected-snapshot | ""> [port]
  local got
  got=$(snapshot "${2:-443}")
  if [ -n "$1" ]; then
    [ "$got" = "$1" ] || { log "answers changed: expected [$1] got [$got]"; return 1; }
  else
    all_ok "$got" || { log "not every host answers 200: [$got]"; return 1; }
  fi
  served_cert_matches_disk "${2:-443}" \
    || { log "the certificate served is not $CERT_DIR/letsencrypt-domain.pem"; return 1; }
  if [ -n "${CERT_BASELINE:-}" ]; then certs_unchanged "$CERT_BASELINE" "$(cert_sweep "${2:-443}")" || return 1; fi
  purge_reachable || return 1
  redis_reachable || return 1
  upstreams_reachable || return 1
}
