#!/usr/bin/env bash
#
# Shared by blue-green.sh, try-issuance.sh and reload-config.sh. Source it, do
# not run it. Everything here runs ON the production host (copy proxy/deploy/
# across, or run it in place from a checkout):
#
#   scp -r proxy/deploy blot:~/proxy-deploy
#
# Settings come from the environment, with these defaults for production:
#
#   PROXY_ENV_FILE         /etc/blot/proxy.env  docker --env-file for the proxy
#                                               (see proxy.env.example)
#   PROXY_DISK_CACHE_DIR   /var/instance-ssd/disk-cache  the disk cache every
#                                               proxy container on the host shares
#   PROXY_LOG_DIR          /var/instance-ssd/logs   fail2ban and logrotate
#                                               read the access log here
#   PROXY_CERT_DIR         /etc/ssl/private     wildcard cert + key (read-only)
#   PROXY_GLOBAL_STATIC_DIR /var/www/blot/app/blog/static  the app's own static
#                                               assets, read-only (see run_args())
#   PROXY_AUTOSSL_VOLUME   blot-proxy-auto-ssl  dehydrated account state
#   PROXY_NODE_CONTAINER   blot-container-blue  a Node container to purge from
#   PROXY_PURGE_URLS       (read from $PROXY_NODE_CONTAINER's environment)  comma separated
#   PROXY_CANARY_HOST      preview-of-wireframe-on-david.<BLOT_HOST>
#   PROXY_REGISTRY_URL     ghcr.io/blotcms/blot-proxy  for a bare tag / commit SHA
#   PROXY_HEALTH_TIMEOUT   60                   seconds to wait for a new container
#   PROXY_DRAIN_TIMEOUT    30                   seconds an old container may drain
#   PROXY_UPSTREAM_WAIT    180                  seconds the preflight keeps retrying an
#                                               unhealthy upstream (a Node deploy
#                                               restarting its container); 0 = one try
#   PROXY_DEPLOY_LOCK      /tmp/blot-proxy-deploy.lock  held by every deploy script
#   PROXY_SKIP_CERT_SWEEP  (unset)              1 skips the custom-domain certificate
#                                               checks (see cert_baseline and
#                                               certs_all_served)
#   PROXY_NOFILE           65536                --ulimit nofile=N:N. Each proxied
#                                               connection holds ~2 fds (client +
#                                               upstream), so worker_connections
#                                               10000 (proxy/config/initial.conf)
#                                               needs ~20000 plus cache/log fds;
#                                               this leaves headroom above that
#
# PROXY_DEPLOY_SLEEP replaces `sleep` (the tests set it to a no-op).

ENV_FILE="${PROXY_ENV_FILE:-/etc/blot/proxy.env}"
DISK_CACHE_DIR="${PROXY_DISK_CACHE_DIR:-/var/instance-ssd/disk-cache}"
LOG_DIR="${PROXY_LOG_DIR:-/var/instance-ssd/logs}"
CERT_DIR="${PROXY_CERT_DIR:-/etc/ssl/private}"
GLOBAL_STATIC_DIR="${PROXY_GLOBAL_STATIC_DIR:-/var/www/blot/app/blog/static}"
AUTOSSL_VOLUME="${PROXY_AUTOSSL_VOLUME:-blot-proxy-auto-ssl}"
NODE_CONTAINER="${PROXY_NODE_CONTAINER:-blot-container-blue}"
HEALTH_TIMEOUT="${PROXY_HEALTH_TIMEOUT:-60}"
DRAIN_TIMEOUT="${PROXY_DRAIN_TIMEOUT:-30}"
UPSTREAM_WAIT="${PROXY_UPSTREAM_WAIT:-180}"
HEALTH_SOCK="/run/openresty/health.sock"
LOCK_FILE="${PROXY_DEPLOY_LOCK:-/tmp/blot-proxy-deploy.lock}"
SITE_IP="127.0.0.1"
PRODUCTION_ACME_CA="https://acme-v02.api.letsencrypt.org/directory"
# worker_connections is 10000 (proxy/config/initial.conf) and each
# proxied connection holds about two fds (client + upstream), so 10000
# connections can need about 20000; add cache/log/socket fds on top and
# Docker's default (1024) is nowhere close. This is the CONTAINER's limit; the
# config also raises worker_rlimit_nofile itself (to 20480, initial.conf) for
# the same reason. 65536 leaves real headroom above both - a root dockerd
# allows it.
NOFILE="${PROXY_NOFILE:-65536}"

# Never fail because the terminal went away: a deploy ignores SIGPIPE and
# must still be able to finish and roll back with nobody watching.
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" 2>/dev/null || true; }
die() { log "ERROR: $*" >&2; exit 1; }
nap() { ${PROXY_DEPLOY_SLEEP:-sleep} "$1"; }

# Commands which need root (systemctl). `sudo -n` fails rather than prompting,
# and the `deploy` user GitHub runs as has no sudo, so under it this always
# fails: its only caller is blue-green.sh's fresh-start check for a bare-metal
# openresty unit, which then passes without having checked.
sys() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}

# One deploy at a time on this host: two scripts would pick the same colours
# and remove each other's containers. Held (fd 9) until the script exits.
# Deploys run as different users (ec2-user from a Mac, deploy from GitHub), and
# fs.protected_regular refuses a creating open of another user's file in /tmp,
# so an existing lock is opened read-only (flock does not need write access).
acquire_lock() {
  if [ -e "$LOCK_FILE" ]; then
    exec 9<"$LOCK_FILE" || die "cannot open the deploy lock $LOCK_FILE"
  else
    exec 9>>"$LOCK_FILE" || die "cannot open the deploy lock $LOCK_FILE"
    chmod 666 "$LOCK_FILE" 2>/dev/null || true
  fi
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
  # binds the unauthenticated /purge and /inspect on every interface.
  [ -n "$(env_value "$ENV_FILE" PROXY_PRIVATE_IP)" ] || die "PROXY_PRIVATE_IP is not set in $ENV_FILE"
  CANARY_HOST="${PROXY_CANARY_HOST:-preview-of-wireframe-on-david.$BLOT_HOST}"
  # Any other PROXY_* setting left empty overrides the image's default with
  # nothing too (an empty CA, resolver or upstream renders an unusable config).
  local empty
  empty="$(grep -E "^(export )?PROXY_[A-Z_]+=[\"']*$" "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
  [ -z "$empty" ] || die "$ENV_FILE sets $empty to nothing, which overrides the image's default with an empty value: give it a value or remove the line"
  # A staging (or test) ACME directory left in the env file would have every
  # new custom domain issued a certificate no browser trusts.
  local ca
  ca="$(env_value "$ENV_FILE" PROXY_ACME_CA || true)"
  if [ -n "$ca" ] && [ "$ca" != "$PRODUCTION_ACME_CA" ] && [ "${PROXY_ALLOW_ACME_CA:-}" != 1 ]; then
    die "PROXY_ACME_CA in $ENV_FILE is $ca, not Let's Encrypt production: remove it (it is for try-issuance.sh, which sets it itself), or set PROXY_ALLOW_ACME_CA=1"
  fi
}

# A bare tag or commit SHA means the image CI publishes
# (.github/workflows/proxy-image.yml); anything with a / or : is used as given.
PROXY_REGISTRY_URL="${PROXY_REGISTRY_URL:-ghcr.io/blotcms/blot-proxy}"
resolve_image() {
  case "$1" in */*|*:*) echo "$1" ;; *) echo "$PROXY_REGISTRY_URL:$1" ;; esac
}

# After a committed deploy, remove the other tags of the deployed image's
# repository, so proxy deploys do not pile up ~400MB images between app deploys
# (scripts/deploy prunes every unused image, but only when it runs). Only this
# repository, never the image just deployed; `docker rmi` refuses an image any
# container still uses. Best effort: it never fails the deploy.
prune_old_images() { # prune_old_images <image just deployed>
  case "$1" in *@*) return 0 ;; esac
  local repo="${1%:*}" ref
  docker images "$repo" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | while read -r ref; do
    if [ "$ref" = "$1" ] || [ "$ref" = "$repo:<none>" ]; then continue; fi
    if docker rmi "$ref" >/dev/null 2>&1; then log "Removed old image $ref"; fi
  done
  return 0
}

ensure_image() { # pull only when it is not already on the host
  docker image inspect "$1" >/dev/null 2>&1 || { log "Pulling $1"; docker pull "$1"; }
}

# The upstream address for a colour (BLUE, GREEN, YELLOW): PROXY_UPSTREAM_*
# from the env file, else the host port the Node container publishes.
upstream_addr() { # upstream_addr <COLOUR> <default>
  local addr
  addr="$(env_value "$ENV_FILE" "PROXY_UPSTREAM_$1")"
  echo "${addr:-$2}"
}

UPSTREAMS="BLUE:127.0.0.1:8088 GREEN:127.0.0.1:8089 YELLOW:127.0.0.1:8090"

# Empty a cache directory without waiting for millions of files to be deleted:
# move every top-level entry (a cache has few: its shard directories) into
# .trash/<timestamp>/, which is instant on one filesystem, then delete that in
# a detached container so the deploy carries on. The files belong to uid 1000
# (the nginx worker), so both containers run as root, from <image> only because
# it is already on the host and has sh and rm.
reset_cache_dir() { # reset_cache_dir <host dir> <image>
  local dir="$1" image="$2" trash
  trash=".trash/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  log "Emptying $dir (moving its contents to $dir/$trash, deleted in the background)"
  docker run --rm --user 0 --entrypoint sh -v "$dir":/cache "$image" -c '
    set -e; cd /cache; mkdir -p "$1"
    for e in .[!.]* ..?* *; do
      { [ -e "$e" ] || [ -L "$e" ]; } && [ "$e" != .trash ] && mv "$e" "$1/"
    done
    exit 0' sh "$trash" >/dev/null || return 1
  # all of .trash, so what an interrupted earlier reset left goes too
  docker run -d --rm --user 0 --entrypoint sh -v "$dir":/cache "$image" -c 'rm -rf /cache/.trash' >/dev/null || true
}

# Arguments common to every real proxy container.
# Host networking: the default upstreams are 127.0.0.1:8088-8090 and the Node
# containers publish those ports on the host. Upstreams written unix:/run/blot/...
# are the Node containers' sockets: bind-mounted with --mount so a missing
# /run/blot fails the deploy rather than Docker creating it as root.
run_args() { # run_args <name>
  local var addr unix=
  for var in $UPSTREAMS; do
    addr="$(upstream_addr "${var%%:*}" "${var#*:}")"
    case "$addr" in unix:*) unix=1 ;; esac
  done
  RUN_ARGS=(
    --name "$1"
    --network host
    --cap-add SYS_NICE
    --ulimit "nofile=$NOFILE:$NOFILE"
    --log-driver json-file --log-opt max-size=512m --log-opt max-file=1
    --env-file "$ENV_FILE"
    -v "$DISK_CACHE_DIR":/var/cache/openresty
    -v "$LOG_DIR":/var/log/openresty
    -v "$AUTOSSL_VOLUME":/etc/resty-auto-ssl
    -v "$CERT_DIR":/etc/ssl/private:ro
    # Mounted at the path the image defaults to (GLOBAL_STATIC_FILES_DIR in
    # proxy/build/locals.js), so `try_files` on cdn.<host> finds the app's
    # own static files on disk instead of falling through to @cdn_node,
    # which misses the Cache-Control/CORS headers `location /` sets.
    -v "$GLOBAL_STATIC_DIR":/var/www/blot/app/blog/static:ro
  )
  if [ -n "$unix" ]; then
    RUN_ARGS+=(--mount type=bind,source=/run/blot,target=/run/blot)
  fi
}

# Render the image's config with this host's settings and have nginx parse it.
# Only the certificate directory is mounted: the check must not touch the live
# cache or logs. `openresty -t` can bind the listeners, and on the Docker bridge
# the purge listener's PROXY_PRIVATE_IP is not a local address (prod: "bind()
# ... failed (99: Address not available)"), so allow non-local binds in the
# container's own network namespace.
validate_image() { # validate_image <image>
  docker run --rm --entrypoint bash \
    --sysctl net.ipv4.ip_nonlocal_bind=1 \
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

# SCAN by hand: `redis-cli --scan --count` needs redis-cli 7, and the
# production host has 6.2, whose --scan uses SCAN's default COUNT of 10 (a
# round trip per 10 keys of the whole keyspace).
# Fails (rather than listing nothing) if a SCAN fails or returns an error
# reply, so a broken Redis cannot pass for one with no custom domains. The loop
# is not piped: a failure inside a pipeline would be lost.
custom_cert_domains() {
  local cursor=0 reply keys=""
  while :; do
    reply=$(redis-cli -h "$REDIS_HOST" --raw scan "$cursor" match 'ssl:*:latest' count 1000) || return 1
    cursor=$(printf '%s\n' "$reply" | head -n 1)
    case "$cursor" in ''|*[!0-9]*) return 1 ;; esac
    keys="$keys$(printf '%s\n' "$reply" | tail -n +2)
"
    [ "$cursor" != 0 ] || break
  done
  printf '%s' "$keys" | sed '/^$/d' | sed -E 's/^ssl:(.*):latest$/\1/' | sort -u
}

# The proxy treats a stored certificate whose expiry has passed as missing
# (get_cert in proxy/config/init.conf), so a domain that presents none (or, on
# a swap, a different one, once the replacement issues a new certificate)
# because its stored certificate had expired is not the replacement's fault.
# expired_cert_domains lists such domains, from domain names on stdin. It is
# called BEFORE the replacement starts (or, on a fresh start, before the
# sweep), because the replacement's own handshakes can replace the stored
# certificate. The expiry is read from the stored JSON with awk, as no JSON
# tool is guaranteed on the host. One redis-cli session reads every key, one
# reply line per key.
expired_cert_domains() {
  local domains
  domains="$(sed '/^$/d')"
  [ -n "$domains" ] || return 0
  paste -d' ' <(printf '%s\n' "$domains") \
    <(printf '%s\n' "$domains" | sed 's/^/get ssl:/; s/$/:latest/' | redis-cli -h "$REDIS_HOST" --raw 2>/dev/null \
      | awk '{ if (match($0, /"expiry":[0-9]+/)) print substr($0, RSTART + 9, RLENGTH - 9); else print "-" }') \
    | awk -v now="$(date +%s)" '$2 != "-" && $2 + 0 <= now { print $1 }'
}

# drop_expired: lines starting with a domain name on stdin, minus the domains
# in $EXPIRED_CERTS (newline separated)
drop_expired() {
  awk -v list="${EXPIRED_CERTS:-}" 'BEGIN { n = split(list, a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") e[a[i]] = 1 } !($1 in e)'
}

# cert_sweep [port] -> sorted "<domain> <sha256 fingerprint | none>" lines
cert_sweep() {
  local port="${1:-443}" domains
  domains="$(custom_cert_domains)" || return 1
  printf '%s\n' "$domains" | sed '/^$/d' | xargs -r -P 16 -I{} bash -c '
    fp=$(echo | timeout 5 openssl s_client -connect "$1:$2" -servername "$3" 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
    echo "$3 ${fp:-none}"' _ "$SITE_IP" "$port" {} | sort
}

# Every domain that presented a certificate before must present the same one
# now. (A domain with none before is not held against the replacement.)
certs_unchanged() { # certs_unchanged <baseline> <now>
  local bad
  bad=$(comm -23 <(printf '%s\n' "$1" | grep -v ' none$' | sort) <(printf '%s\n' "$2" | sort) | drop_expired)
  [ -z "$bad" ] || {
    log "custom-domain certificates changed or went missing ($(printf '%s\n' "$bad" | wc -l | tr -d ' ')): first few, as they were:"
    printf '%s\n' "$bad" | head -5 | while read -r line; do log "  $line"; done
    return 1
  }
}

# Record the certificates the running proxy serves; CERT_BASELINE is what
# live_checks compares against. Refuses to go on with no
# certificates to compare unless PROXY_SKIP_CERT_SWEEP=1.
cert_baseline() {
  CERT_BASELINE=""
  [ "${PROXY_SKIP_CERT_SWEEP:-}" != 1 ] || { log "PROXY_SKIP_CERT_SWEEP=1: not comparing custom-domain certificates"; return 0; }
  command -v redis-cli >/dev/null 2>&1 \
    || { log "redis-cli is not installed, so custom-domain certificates cannot be compared (PROXY_SKIP_CERT_SWEEP=1 to skip)"; return 1; }
  CERT_BASELINE="$(cert_sweep | sed '/^$/d')"
  EXPIRED_CERTS="$(printf '%s\n' "$CERT_BASELINE" | awk '{ print $1 }' | expired_cert_domains)"
  local total served
  total=$(printf '%s\n' "$CERT_BASELINE" | sed '/^$/d' | wc -l | tr -d ' ')
  served=$(printf '%s\n' "$CERT_BASELINE" | sed '/^$/d' | grep -vc ' none$' || true)
  [ "$served" -gt 0 ] \
    || { log "no custom-domain certificate could be read from the running proxy ($total in Redis): nothing to compare (PROXY_SKIP_CERT_SWEEP=1 to skip)"; return 1; }
  log "Custom-domain certificates: $served of $total in Redis are being served"
}

# A fresh start has no running proxy to compare with, so require instead that
# the new one presents a certificate for EVERY custom domain in Redis
# (ssl:<domain>:latest), looked up by SNI. A container that cannot read or
# serve them would otherwise pass every other check. A Redis with no custom
# domains has nothing to serve and passes.
certs_all_served() { # certs_all_served [port]
  [ "${PROXY_SKIP_CERT_SWEEP:-}" != 1 ] || { log "PROXY_SKIP_CERT_SWEEP=1: not checking custom-domain certificates"; return 0; }
  command -v redis-cli >/dev/null 2>&1 \
    || { log "redis-cli is not installed, so custom-domain certificates cannot be checked (PROXY_SKIP_CERT_SWEEP=1 to skip)"; return 1; }
  local sweep total missing wildcard redis_wildcard
  EXPIRED_CERTS="$(custom_cert_domains | expired_cert_domains)"
  sweep="$(cert_sweep "${1:-443}")" \
    || { log "cannot list the custom domains in Redis (SCAN failed), so their certificates cannot be checked"; return 1; }
  sweep="$(printf '%s\n' "$sweep" | sed '/^$/d')"
  total=$(printf '%s\n' "$sweep" | sed '/^$/d' | wc -l | tr -d ' ')
  # A custom domain served the wildcard file is auto-ssl falling back: it
  # could not load that domain's certificate, and browsers will reject it.
  wildcard=$(openssl x509 -in "$CERT_DIR/letsencrypt-domain.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  # Custom domains fall back to the disk file today, but neither wildcard
  # (disk, or the current one in Redis) is ever a custom domain's certificate.
  redis_wildcard=$(redis_wildcard_fingerprint)
  missing="$(printf '%s\n' "$sweep" | awk -v w="$wildcard" -v r="$redis_wildcard" '$2 == "none" || (w != "" && $2 == w) || (r != "" && $2 == r) { print $1 }' | drop_expired)"
  if [ -n "$missing" ]; then
    log "no certificate of its own presented for $(printf '%s\n' "$missing" | wc -l | tr -d ' ') of $total custom domains in Redis: first few:"
    printf '%s\n' "$missing" | head -5 | while read -r line; do log "  $line"; done
    return 1
  fi
  log "Custom-domain certificates: all $total in Redis are being served"
}

all_ok() { ! echo "$1" | tr ' ' '\n' | grep -v '=200$' | grep -q .; }

# SHA-256 fingerprint of the wildcard certificate in Redis, empty if there is
# none or it cannot be read.
redis_wildcard_fingerprint() {
  local pem
  pem=$(redis-cli -h "$REDIS_HOST" --raw get blot:openresty:ssl:pem 2>/dev/null || true)
  [ -n "$pem" ] || return 0
  echo "$pem" | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true
}

# The certificate being served must be the wildcard certificate the app keeps
# in Redis (renewed there by app/scheduler/renew-wildcard-ssl.js), not the
# image's self-signed placeholder or a stale one. The file on disk is only the
# fallback when Redis has none, and goes stale once the app renews.
served_cert_matches_wildcard() { # served_cert_matches_wildcard [port]
  local served expected
  served=$(echo | openssl s_client -connect "$SITE_IP:${1:-443}" -servername "$BLOT_HOST" 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  expected=$(redis_wildcard_fingerprint)
  [ -n "$expected" ] || expected=$(openssl x509 -in "$CERT_DIR/letsencrypt-domain.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  [ -n "$served" ] && [ "$served" = "$expected" ]
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

# No checked host exercises every upstream, so probe each one directly.
upstreams_reachable() {
  local var addr target=() # target: curl's arguments for the address
  for var in $UPSTREAMS; do
    addr="$(upstream_addr "${var%%:*}" "${var#*:}")"
    case "$addr" in
      unix:*) target=(--unix-socket "${addr#unix:}" http://localhost/health) ;;
      *) target=("http://$addr/health") ;;
    esac
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${target[@]}" || true)" = 200 ] \
      || { log "upstream $addr (PROXY_UPSTREAM_${var%%:*}) is not healthy"; return 1; }
  done
}

# Preflight only: a Node deploy running at the same time restarts its
# containers one at a time, so an upstream can be down for a minute or two.
# Retry for up to <timeout> seconds before refusing. Not for use once the new
# colour exists: there an unhealthy upstream must fail and roll back at once.
wait_upstreams_reachable() { # wait_upstreams_reachable <timeout>
  local deadline=$(( $(date +%s) + $1 ))
  until upstreams_reachable; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    log "Retrying in 10s (waiting up to ${1}s for a concurrent Node deploy to finish)"
    nap 10
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
  served_cert_matches_wildcard "${2:-443}" \
    || { log "the certificate served is not the wildcard certificate in Redis (or $CERT_DIR/letsencrypt-domain.pem if Redis has none)"; return 1; }
  if [ -n "${CERT_BASELINE:-}" ]; then certs_unchanged "$CERT_BASELINE" "$(cert_sweep "${2:-443}")" || return 1; fi
  purge_reachable || return 1
  redis_reachable || return 1
  upstreams_reachable || return 1
}
