#!/usr/bin/env bash
#
# Swap the running proxy container for a new IMAGE, container to container.
#
#   proxy/deploy/blue-green.sh <commit-sha | image>
#
# Run it on the production host. For the one-off move from the bare-metal
# OpenResty to the first container use cutover-from-baremetal.sh instead; for a
# config-only change, deploy a new image the same way (reload-config.sh needs a
# bind-mounted conf dir, which these scripts' containers do not have).
#
# How it works
# ------------
# The two containers run with `--network host`. The generated config sets
# `reuseport` on :80 and :443, so the new container joins the listening group
# while the old one is still serving; the kernel spreads new connections over
# both. Once the new one answers its OWN health socket, the old one is stopped
# with a drain timeout (entrypoint.sh runs `openresty -s quit`, so in-flight
# requests finish). See proxy/README.md "Deployment".
#
# Order of events, and what protects each step
#   1. Preflight, nothing started: the image is on the host, its config
#      renders and parses with this host's settings and certificate, it logs to
#      the file fail2ban reads, and the site and canary blog answer today.
#   2. Start the new colour (restart policy `no`) and wait for its health.
#      If it never becomes healthy, or the script is interrupted, it is
#      removed and the old one is untouched. With no old colour (a fresh
#      start) the same site checks as step 4 run before it is made permanent.
#   3. Stop the old colour, but do not remove it.
#   4. Check the site as the outside world sees it: same status codes as
#      before, certificate served is the one on disk, every custom-domain
#      certificate in Redis is the one served before, Node can still reach
#      the purge endpoint. If any check fails the old colour is started again
#      and the new one removed (kept if the old one cannot be brought back).
#   5. Only then remove the old one. (The new one gets its restart policy
#      before step 3, so a daemon restart in between still leaves a proxy.)
#      Steps 2-5 run under a trap: any failure or interrupt undoes them.
#
# Known limitation: while both are up (seconds), a cache purge sent to
# 127.0.0.1 or the private address reaches only one of them. Keys the other
# cached in that window are not purged (cacher.lua tracks keys in per-process
# memory). Deploy at a quiet time (see proxy/deploy/README.md).
set -euo pipefail

NEW_IMAGE="${1:?usage: blue-green.sh <commit-sha | image>}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$DIR/common.sh"

NEW_IMAGE="$(resolve_image "$NEW_IMAGE")"
load_env
acquire_lock
[ -r "$CERT_DIR/letsencrypt-domain.pem" ] && [ -r "$CERT_DIR/letsencrypt-domain.key" ] \
  || die "no certificate in $CERT_DIR (letsencrypt-domain.pem / .key)"
[ -d "$CACHE_DIR" ] || die "cache directory $CACHE_DIR does not exist"
[ -d "$LOG_DIR" ] || die "log directory $LOG_DIR does not exist"

if running blot-proxy-blue && running blot-proxy-green; then
  # e.g. a rollback that kept the new colour because the old one would not come
  # back: by name alone we might remove the one that is actually healthy.
  die "blot-proxy-blue and blot-proxy-green are both running: stop the unhealthy one by hand first"
fi
if running blot-proxy-blue; then
  OLD=blot-proxy-blue; NEW=blot-proxy-green
elif running blot-proxy-green; then
  OLD=blot-proxy-green; NEW=blot-proxy-blue
else
  OLD=""; NEW=blot-proxy-blue
  if sys systemctl is-active --quiet openresty || sys systemctl is-enabled --quiet openresty; then
    die "bare-metal OpenResty is active or still enabled (it would race the container for :80/:443 after a reboot) and no proxy container is running: use cutover-from-baremetal.sh"
  fi
  log "No proxy container running - starting $NEW fresh (no overlap)."
fi

log "Preflight"
ensure_image "$NEW_IMAGE"
report=$(validate_image "$NEW_IMAGE") \
  || { echo "$report" >&2; die "$NEW_IMAGE does not render a valid config with $ENV_FILE"; }
if [ "${ALLOW_STDOUT_LOGS:-}" != "1" ]; then
  image_logs_to_file "$NEW_IMAGE" \
    || die "$NEW_IMAGE logs to stdout, so fail2ban would see nothing. Build with LOG_TO_STDOUT=false (ALLOW_STDOUT_LOGS=1 to override)"
fi

if [ -n "$OLD" ]; then
  BASELINE=$(snapshot)
  all_ok "$BASELINE" || die "the site is not healthy before the deploy [$BASELINE]: not swapping"
  cert_baseline || die "cannot record the custom-domain certificates the running proxy serves: not swapping"
fi

log "Starting $NEW from $NEW_IMAGE"
docker rm -f "$NEW" >/dev/null 2>&1 || true

# From here $NEW exists and, once started, takes a share of live traffic via
# reuseport, so ANY exit before the commit (a failed check, Ctrl-C, a failed
# docker command) must undo what was done. STATE says how far we got:
#   starting  $NEW may exist; $OLD untouched  -> remove $NEW
#   swapping  $OLD stopped                    -> start $OLD, then remove $NEW
#   committed nothing to undo
STATE=starting
swap_rollback() {
  local status=$?
  case "$STATE" in
    starting)
      log "Failed or interrupted before the swap (exit $status): removing $NEW, ${OLD:-nothing} left as it was"
      docker logs --tail 50 "$NEW" >&2 || true
      docker rm -f "$NEW" >/dev/null 2>&1 || true
      ;;
    swapping)
      log "Swap interrupted or failed (exit $status): putting $OLD back and removing $NEW"
      # $NEW may be the only proxy answering if $OLD cannot come back, so it is
      # removed only once $OLD is up and healthy.
      if docker start "$OLD" >/dev/null 2>&1 && wait_healthy "$OLD" "$HEALTH_TIMEOUT"; then
        docker logs --tail 50 "$NEW" >&2 || true
        docker rm -f "$NEW" >/dev/null 2>&1 || true
      else
        log "WARNING: $OLD did not come back healthy. Keeping $NEW running (it may be the only proxy serving): sort it out by hand"
      fi
      ;;
  esac
  exit "$status"
}
trap swap_rollback EXIT
trap 'exit 130' INT TERM
trap '' HUP PIPE

run_args "$NEW"
docker create --restart no "${RUN_ARGS[@]}" "$NEW_IMAGE" >/dev/null
docker start "$NEW" >/dev/null

log "Waiting up to ${HEALTH_TIMEOUT}s for $NEW to answer its own health socket"
wait_healthy "$NEW" "$HEALTH_TIMEOUT" || die "$NEW did not become ready in ${HEALTH_TIMEOUT}s"
log "$NEW is ready."

if [ -z "$OLD" ]; then
  # Nothing to compare with, but the site must still answer 200 for every
  # checked host with the right certificate before the container is made permanent.
  log "Checking the site through $NEW"
  live_checks "" || die "checks failed for $NEW_IMAGE"
  docker update --restart unless-stopped "$NEW" >/dev/null
  STATE=committed
  log "$NEW is now serving."
  exit 0
fi

# The new colour must survive a daemon or host restart BEFORE the old one is
# stopped: a container that was stopped by hand is not restarted, so between the
# stop and a later policy change a restart would leave neither colour running.
# If this fails the old one is untouched and the trap removes the new one.
docker update --restart unless-stopped "$NEW" >/dev/null

STATE=swapping
log "Draining and stopping $OLD (timeout ${DRAIN_TIMEOUT}s)"
docker stop --time "$DRAIN_TIMEOUT" "$OLD" >/dev/null

log "Checking the site through $NEW"
live_checks "$BASELINE" || die "checks failed after the swap to $NEW_IMAGE"

STATE=committed
docker rm "$OLD" >/dev/null 2>&1 || true
log "Swapped $OLD -> $NEW"
