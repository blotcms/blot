#!/usr/bin/env bash
#
# ONE-OFF: move :80/:443 from the bare-metal OpenResty (systemd unit
# `openresty`) to the first proxy container.
#
#   proxy/deploy/cutover-from-baremetal.sh [--dry-run] [--yes] [--soak <seconds>] <commit-sha | image>
#
# Run it on the production host, inside tmux or screen (so a dropped SSH
# connection cannot interrupt it half way), at a quiet time. After this,
# every later image change uses blue-green.sh.
#
# Why this cannot be zero-downtime
# --------------------------------
# blue-green.sh overlaps two containers with SO_REUSEPORT. The bare-metal
# nginx binds :80 and :443 WITHOUT reuseport, and the kernel refuses a second
# reuseport socket next to a plain one. So the bare-metal process must stop
# listening before the container can. The gap is the container's start time
# (a few seconds); the script measures and prints it. Everything else is done
# beforehand so that this gap is the only risk.
#
# What it does
# ------------
#   1. Preflight (read-only): the bare-metal proxy is serving, no proxy
#      container exists yet, the Node containers are healthy, the certificate
#      is valid and matches its key, the image renders a valid config with
#      this host's settings and writes the access log fail2ban reads, the
#      renewal script reloads the container too, and Node can reach the purge
#      endpoint. The statuses the site, canary blog (and PROXY_CUSTOM_DOMAIN)
#      return today are recorded as the baseline, together with the
#      certificate bare-metal presents for EVERY custom domain in Redis
#      (ssl:*:latest), looked up by SNI.
#   2. Rehearsal: run the image on another port (127.0.0.1:18443) on the
#      Docker bridge, pointed at the real Node containers and Redis with the
#      real certificate, and require the same answers and the same custom-domain
#      certificates as the baseline. It does
#      not mount the live cache or logs. Nothing user-facing changes.
#      --dry-run stops here.
#   3. Confirmation (type `cutover`, or --yes).
#   4. Cutover: create the container (restart policy `no`), stop the bare-metal
#      unit, start the container, wait for health, then require the same
#      answers as the baseline over the real ports, the served certificate to
#      be the file on disk, every custom-domain certificate to be unchanged,
#      and the purge endpoint to be reachable.
#      ANY failure, or an interrupt, rolls back: the container is removed and
#      the bare-metal unit started again. The unit stays ENABLED and the
#      container has no restart policy, so a reboot at this point also returns
#      to bare-metal.
#   5. Soak (default 120s): keep checking every 5s; three failures in a row
#      roll back.
#   6. Commit: the bare-metal unit is disabled (so a reboot does not race the
#      container for :80/:443) and the container gets `unless-stopped`.
#      Bare-metal OpenResty stays installed for a manual rollback:
#          docker rm -f blot-proxy-blue; sudo systemctl enable --now openresty
set -euo pipefail

DRY_RUN=0; ASSUME_YES=0; SOAK="${PROXY_SOAK_SECONDS:-120}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --soak) SOAK="${2:?--soak needs a number of seconds}"; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) IMAGE="$1" ;;
  esac
  shift
done
case "$SOAK" in ''|*[!0-9]*) echo "--soak / PROXY_SOAK_SECONDS must be a non-negative integer, got '$SOAK'" >&2; exit 2 ;; esac
IMAGE="${IMAGE:?usage: cutover-from-baremetal.sh [--dry-run] [--yes] [--soak <seconds>] <commit-sha | image>}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$DIR/common.sh"
IMAGE="$(resolve_image "$IMAGE")"

NEW=blot-proxy-blue
REHEARSAL=blot-proxy-rehearsal
REHEARSAL_HTTPS=18443
RENEW_SCRIPT="${PROXY_RENEW_SCRIPT:-/home/ec2-user/scripts/renew-wildcard-ssl.sh}"
UPSTREAM_PORTS="${PROXY_UPSTREAM_PORTS:-8088 8089 8090}"

DISABLED=0        # set once the unit has been (or is being) disabled
PHASE=preflight   # preflight -> rehearsal -> critical -> committed
cleanup() {
  status=$?
  docker rm -f "$REHEARSAL" >/dev/null 2>&1 || true
  if [ "$PHASE" = critical ]; then
    log "Interrupted or failed during the cutover (exit $status)"
    rollback
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Put bare-metal back. The container is stopped, not removed: bare-metal cannot
# bind :80/:443 beside it, but until bare-metal answers it is the only working
# proxy, so if the fallback fails it is started again and kept for the operator.
rollback() {
  log "ROLLING BACK to bare-metal OpenResty"
  docker stop --time 10 "$NEW" >/dev/null 2>&1 || true
  # finalizing had started: the unit must come back enabled or the next reboot
  # starts neither proxy
  if [ "$DISABLED" = 1 ]; then
    sys systemctl enable openresty >/dev/null 2>&1 || log "WARNING: could not re-enable openresty: run 'sudo systemctl enable openresty' NOW"
  fi
  sys systemctl start openresty || log "WARNING: could not start openresty: run 'sudo systemctl start openresty' NOW"
  local i
  for i in $(seq 1 30); do
    if [ "$(https_status "$BLOT_HOST")" = 200 ]; then
      docker rm -f "$NEW" >/dev/null 2>&1 || true
      log "Bare-metal OpenResty is serving again."; PHASE=preflight; return 0
    fi
    nap 1
  done
  log "WARNING: bare-metal OpenResty is not answering 200: starting $NEW again and keeping it. Check 'systemctl status openresty' NOW"
  sys systemctl stop openresty >/dev/null 2>&1 || true
  # The container may already have its restart policy (finalizing got that far):
  # put the unit back to disabled too, or a reboot would start both on :80/:443.
  if [ "$DISABLED" = 1 ]; then
    sys systemctl disable openresty >/dev/null 2>&1 || log "WARNING: could not disable openresty: run 'sudo systemctl disable openresty' NOW"
  fi
  docker start "$NEW" >/dev/null 2>&1 || log "WARNING: could not start $NEW either: no proxy is serving"
  PHASE=preflight
  return 1
}

refuse() { die "preflight: $*"; }

# ---- 1. preflight -----------------------------------------------------------
log "Preflight (nothing is changed)"

if [ "$DRY_RUN" = 0 ] && [ -z "${TMUX:-}${STY:-}" ] && [ "${PROXY_CUTOVER_DETACHED:-}" != 1 ]; then
  refuse "run this inside tmux or screen so a dropped SSH connection cannot interrupt it (PROXY_CUTOVER_DETACHED=1 if it is otherwise detached)"
fi

sys true 2>/dev/null || refuse "passwordless sudo is required (systemctl)"
load_env
acquire_lock
log "Host $BLOT_HOST, canary $CANARY_HOST, image $IMAGE"

sys systemctl is-active --quiet openresty || refuse "bare-metal openresty is not active: nothing to cut over from (use blue-green.sh to start a container fresh)"
existing=$(docker ps -a --format '{{.Names}}' | grep '^blot-proxy-' || true)
[ -z "$existing" ] || refuse "proxy container(s) already exist ($(echo "$existing" | tr '\n' ' ')): this is not a first cutover, use blue-green.sh"

for f in letsencrypt-domain.pem letsencrypt-domain.key; do
  [ -s "$CERT_DIR/$f" ] || refuse "$CERT_DIR/$f is missing or empty"
done
openssl x509 -in "$CERT_DIR/letsencrypt-domain.pem" -noout -checkend $((14 * 86400)) >/dev/null \
  || refuse "the certificate expires within 14 days (or is unreadable): renew it first"
[ "$(openssl x509 -in "$CERT_DIR/letsencrypt-domain.pem" -noout -pubkey | openssl sha256)" = \
  "$(openssl pkey -in "$CERT_DIR/letsencrypt-domain.key" -pubout | openssl sha256)" ] \
  || refuse "the certificate and key in $CERT_DIR do not match"
[ -d "$CACHE_DIR" ] || refuse "cache directory $CACHE_DIR does not exist"
[ -d "$LOG_DIR" ] || refuse "log directory $LOG_DIR does not exist"

# The renewal cron job and the custom-certificate repair helpers reload or
# restart OpenResty. Once the unit is stopped that fails, and the container
# would keep serving the old certificate until it expires.
SCRIPTS_DIR="$(dirname "$RENEW_SCRIPT")"
for helper in "$RENEW_SCRIPT" "$SCRIPTS_DIR/identify-expiring-certs.sh" "$SCRIPTS_DIR/purge-expired-ssl.sh"; do
  grep -q 'blot-proxy' "$helper" 2>/dev/null \
    || refuse "$helper does not act on the proxy container: run config/openresty/deploy-config.sh from this branch first"
done

for port in $UPSTREAM_PORTS; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/health" || true)" = 200 ] \
    || refuse "the Node container on :$port is not healthy"
done

# The configured upstreams themselves (the rehearsal can only reach the default
# ports through the bridge, so a custom PROXY_UPSTREAM_* would go untested).
upstreams_reachable || refuse "a configured upstream is not healthy"

ensure_image "$IMAGE"
report=$(validate_image "$IMAGE") || { echo "$report" >&2; refuse "$IMAGE does not render a valid config with $ENV_FILE"; }
if [ "${ALLOW_STDOUT_LOGS:-}" != "1" ]; then
  image_logs_to_file "$IMAGE" \
    || refuse "$IMAGE logs to stdout, so fail2ban and the log helpers would see nothing. Build it with LOG_TO_STDOUT=false (ALLOW_STDOUT_LOGS=1 to override)"
fi

purge_reachable || refuse "Node cannot reach the purge endpoint (see BLOT_REVERSE_PROXY_URLS and PROXY_PRIVATE_IP)"

BASELINE=$(snapshot)
all_ok "$BASELINE" || refuse "bare-metal is not answering 200 for every checked host [$BASELINE]"
log "Baseline: $BASELINE"
cert_baseline || refuse "cannot record the custom-domain certificates bare-metal serves"

# ---- 2. rehearsal -----------------------------------------------------------
PHASE=rehearsal
log "Rehearsal: the image on 127.0.0.1:$REHEARSAL_HTTPS, real Node, Redis and certificate"
GATEWAY=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
[ -n "$GATEWAY" ] || refuse "cannot find the Docker bridge gateway"
read -r -a PORTS <<< "$UPSTREAM_PORTS"
docker rm -f "$REHEARSAL" >/dev/null 2>&1 || true
# No cache or log mounts: the rehearsal must not write to the live ones.
docker run -d --name "$REHEARSAL" --cap-add SYS_NICE \
  --env-file "$ENV_FILE" \
  -e PROXY_FETCH_CDN_IPS=false \
  -e PROXY_PRIVATE_IP=127.0.0.1 \
  -e PROXY_UPSTREAM_BLUE="$GATEWAY:${PORTS[0]}" \
  -e PROXY_UPSTREAM_GREEN="$GATEWAY:${PORTS[1]}" \
  -e PROXY_UPSTREAM_YELLOW="$GATEWAY:${PORTS[2]}" \
  -p "127.0.0.1:$REHEARSAL_HTTPS:443" \
  -v "$CERT_DIR":/etc/ssl/private:ro \
  "$IMAGE" >/dev/null

wait_healthy "$REHEARSAL" "$HEALTH_TIMEOUT" \
  || { docker logs --tail 50 "$REHEARSAL" >&2 || true; refuse "the rehearsal container did not become healthy"; }
REDIS_HOST="$(env_value "$ENV_FILE" PROXY_REDIS_HOST)"
docker exec "$REHEARSAL" bash -c "timeout 5 bash -c '</dev/tcp/$REDIS_HOST/6379'" \
  || refuse "the proxy cannot reach Redis at $REDIS_HOST:6379"
got=$(snapshot "$REHEARSAL_HTTPS")
[ "$got" = "$BASELINE" ] \
  || { docker logs --tail 50 "$REHEARSAL" >&2 || true; refuse "the rehearsal answers differ from bare-metal: expected [$BASELINE] got [$got]"; }
served_cert_matches_disk "$REHEARSAL_HTTPS" || refuse "the rehearsal is not serving $CERT_DIR/letsencrypt-domain.pem"
if [ -n "$CERT_BASELINE" ]; then
  certs_unchanged "$CERT_BASELINE" "$(cert_sweep "$REHEARSAL_HTTPS")" \
    || refuse "the rehearsal does not serve the custom-domain certificates bare-metal does"
fi
docker rm -f "$REHEARSAL" >/dev/null
log "Rehearsal passed: the image answers exactly as bare-metal does."

if [ "$DRY_RUN" = 1 ]; then
  log "--dry-run: stopping here. Nothing user-facing was changed."
  exit 0
fi

# ---- 3. confirmation --------------------------------------------------------
if [ "$ASSUME_YES" != 1 ]; then
  [ -t 0 ] || die "not a terminal: pass --yes to proceed without the prompt"
  echo
  echo "About to stop bare-metal OpenResty and start $NEW on :80/:443."
  echo "Expect a gap of a few seconds. Bare-metal is restored automatically on failure."
  read -r -p "Type 'cutover' to continue: " answer
  [ "$answer" = cutover ] || die "not confirmed"
fi

# ---- 4. cutover -------------------------------------------------------------
# From here an exit must remove $NEW (an interrupt during `docker create` can
# leave it behind, and the next cutover refuses to run beside a stale one).
# Rolling back before the stop is harmless: starting the active unit is a no-op.
PHASE=critical
trap '' HUP PIPE   # a dropped connection must not stop us half way
run_args "$NEW"
docker create --restart no "${RUN_ARGS[@]}" "$IMAGE" >/dev/null   # everything that can fail is done before the stop

START=$(date +%s)
log "Stopping bare-metal OpenResty"
sys systemctl stop openresty
log "Starting $NEW"
docker start "$NEW" >/dev/null
wait_healthy "$NEW" "$HEALTH_TIMEOUT" || { docker logs --tail 50 "$NEW" >&2 || true; die "$NEW did not become healthy"; }
for _ in $(seq 1 30); do
  [ "$(https_status "$BLOT_HOST")" = 200 ] && break
  nap 1
done
log "Serving again after $(( $(date +%s) - START ))s"

live_checks "$BASELINE" || die "the container does not answer as bare-metal did"
log "Cutover checks passed"

# ---- 5. soak ----------------------------------------------------------------
log "Soaking for ${SOAK}s"
fails=0; elapsed=0
while [ "$elapsed" -lt "$SOAK" ]; do
  nap 5; elapsed=$((elapsed + 5))
  if running "$NEW" && healthy "$NEW" && [ "$(snapshot)" = "$BASELINE" ]; then
    fails=0
  else
    fails=$((fails + 1)); log "soak check failed ($fails/3)"
    [ "$fails" -lt 3 ] || die "the container failed 3 checks in a row during the soak"
  fi
done

# ---- 6. commit --------------------------------------------------------------
docker update --restart unless-stopped "$NEW" >/dev/null
DISABLED=1   # from here a failure or interrupt re-enables the unit as part of the rollback
sys systemctl disable openresty >/dev/null || die "could not disable the openresty unit (rolling back)"
PHASE=committed
log "Cutover complete: $NEW serves :80/:443. Bare-metal OpenResty is stopped and disabled, still installed."
log "Manual rollback: docker rm -f $NEW && sudo systemctl enable --now openresty"
