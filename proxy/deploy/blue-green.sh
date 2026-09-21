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
#      If it never becomes healthy it is removed and the old one is untouched.
#   3. Stop the old colour, but do not remove it.
#   4. Check the site as the outside world sees it: same status codes as
#      before, certificate served is the one on disk, Node can still reach
#      the purge endpoint. If any check fails the old colour is started again
#      and the new one removed.
#   5. Only then give the new one its restart policy and remove the old one.
#      Steps 3-5 run under a trap: any failure or interrupt restores the old one.
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
[ -r "$CERT_DIR/letsencrypt-domain.pem" ] && [ -r "$CERT_DIR/letsencrypt-domain.key" ] \
  || die "no certificate in $CERT_DIR (letsencrypt-domain.pem / .key)"
[ -d "$CACHE_DIR" ] || die "cache directory $CACHE_DIR does not exist"
[ -d "$LOG_DIR" ] || die "log directory $LOG_DIR does not exist"

if running blot-proxy-blue; then
  OLD=blot-proxy-blue; NEW=blot-proxy-green
elif running blot-proxy-green; then
  OLD=blot-proxy-green; NEW=blot-proxy-blue
else
  OLD=""; NEW=blot-proxy-blue
  if sys systemctl is-active --quiet openresty; then
    die "bare-metal OpenResty is serving and no proxy container is running: use cutover-from-baremetal.sh"
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
fi

log "Starting $NEW from $NEW_IMAGE"
docker rm -f "$NEW" >/dev/null 2>&1 || true
run_args "$NEW"
docker create --restart no "${RUN_ARGS[@]}" "$NEW_IMAGE" >/dev/null
docker start "$NEW" >/dev/null

log "Waiting up to ${HEALTH_TIMEOUT}s for $NEW to answer its own health socket"
if ! wait_healthy "$NEW" "$HEALTH_TIMEOUT"; then
  docker logs --tail 50 "$NEW" >&2 || true
  docker rm -f "$NEW" >/dev/null 2>&1 || true
  die "$NEW did not become ready in ${HEALTH_TIMEOUT}s; ${OLD:-nothing} left as it was"
fi
log "$NEW is ready."

if [ -z "$OLD" ]; then
  docker update --restart unless-stopped "$NEW" >/dev/null
  log "$NEW is now serving."
  exit 0
fi

# From here the old colour is stopped and the new one has no restart policy, so
# ANY exit before the commit below (a failed check, Ctrl-C, a failed docker
# command) must put the old colour back.
SWAPPING=1
swap_rollback() {
  local status=$?
  if [ "$SWAPPING" = 1 ]; then
    log "Swap interrupted or failed (exit $status): putting $OLD back and removing $NEW"
    docker start "$OLD" >/dev/null 2>&1 || log "WARNING: could not start $OLD"
    wait_healthy "$OLD" "$HEALTH_TIMEOUT" || log "WARNING: $OLD is not healthy"
    docker logs --tail 50 "$NEW" >&2 || true
    docker rm -f "$NEW" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap swap_rollback EXIT
trap 'exit 130' INT TERM
trap '' HUP PIPE

log "Draining and stopping $OLD (timeout ${DRAIN_TIMEOUT}s)"
docker stop --time "$DRAIN_TIMEOUT" "$OLD" >/dev/null

log "Checking the site through $NEW"
live_checks "$BASELINE" || die "checks failed after the swap to $NEW_IMAGE"

# Give the new colour its restart policy BEFORE removing the old one: if this
# fails we can still roll back. Only then is the swap committed.
docker update --restart unless-stopped "$NEW" >/dev/null
SWAPPING=0
docker rm "$OLD" >/dev/null 2>&1 || true
log "Swapped $OLD -> $NEW"
