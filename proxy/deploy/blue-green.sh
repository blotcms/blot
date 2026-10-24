#!/usr/bin/env bash
#
# Swap the running proxy container for a new IMAGE, container to container.
#
#   proxy/deploy/blue-green.sh <commit-sha | image>
#
# Run it on the production host. With no proxy container running it starts
# the first one (no overlap, so a few seconds without a proxy if something
# else was serving); for a config-only change, deploy a new image the same
# way (reload-config.sh needs a bind-mounted conf dir, which these scripts'
# containers do not have).
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
#   2. Start the new colour (restart policy `no`), wait for its health and,
#      for a legacy image, for it to finish rebuilding its purge index. If
#      either fails, or the script is interrupted, it is removed and the old
#      one is untouched. With no old
#      colour (a fresh start) the same site checks as step 4 run before it is
#      made permanent, plus a check that it presents a certificate for every
#      custom domain in Redis.
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
# Cache directories: an image with diskcache.lua keeps its cache in
# $DISK_CACHE_DIR, an older one (it has cacher.lua) in $CACHE_DIR, and the two
# are never mixed. When the kind of image changes (or on a fresh start) the new
# kind's directory is emptied before the new colour starts, because it missed
# every purge since it was last in use; after a successful swap the old kind's
# directory is emptied too, so rolling back with an older blue-green.sh (which
# resets nothing) finds it empty, not stale. A deploy of the same kind keeps
# the warm cache. See proxy/deploy/README.md "Cache directories".
#
# Known limitation: for legacy images, while both colours are up (seconds), a
# cache purge sent to 127.0.0.1 or the private address reaches only one of
# them. Keys the other cached in that window are not purged (cacher.lua tracks
# keys in per-process memory). Disk cache images do not have this gap: every
# container on the host shares one cache directory, so a purge reaching either
# one purges both. Deploy at a quiet time (see proxy/deploy/README.md).
# Two colours with different kinds of cache share nothing, so both directions
# of a kind change have the gap, and the new colour can keep a page that missed
# a purge: after the swap it purges every host its directory has pages for, and
# a swap that is undone starts the old colour on an emptied directory.
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
  # Legacy guard. Production's bare-metal OpenResty has been uninstalled, so
  # this is not a normal state; it protects a host that still has an
  # `openresty` unit, which binds :80/:443 without reuseport (the container
  # cannot share them) and would race the container for them after a reboot.
  if sys systemctl is-active --quiet openresty || sys systemctl is-enabled --quiet openresty; then
    die "this host still has an active or enabled legacy bare-metal 'openresty' systemd unit, which would conflict with the container for :80/:443 (and race it after a reboot): stop and disable it first (sudo systemctl disable --now openresty)"
  fi
  log "No proxy container running - starting $NEW fresh (no overlap)."
fi

log "Preflight"
ensure_image "$NEW_IMAGE"
NEW_KIND="$(image_cache_kind "$NEW_IMAGE")"
NEW_CACHE_DIR="$(cache_dir_for "$NEW_KIND")"
[ -d "$NEW_CACHE_DIR" ] \
  || die "cache directory $NEW_CACHE_DIR does not exist (needed by $NEW_IMAGE, a $NEW_KIND cache image): create it with: sudo install -d -o 1000 -g 1000 $NEW_CACHE_DIR"
OLD_KIND=""
if [ -n "$OLD" ]; then
  OLD_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$OLD")" || die "cannot read the image $OLD runs"
  OLD_KIND="$(image_cache_kind "$OLD_IMAGE")"
fi
report=$(validate_image "$NEW_IMAGE") \
  || { echo "$report" >&2; die "$NEW_IMAGE does not render a valid config with $ENV_FILE"; }
if [ "${ALLOW_STDOUT_LOGS:-}" != "1" ]; then
  image_logs_to_file "$NEW_IMAGE" \
    || die "$NEW_IMAGE logs to stdout, so fail2ban would see nothing. Build with LOG_TO_STDOUT=false (ALLOW_STDOUT_LOGS=1 to override)"
fi

# Before the new colour takes any traffic: a wrong or missing PROXY_UPSTREAM_*
# (e.g. a unix: socket path) would otherwise only show after $OLD is stopped
wait_upstreams_reachable "$UPSTREAM_WAIT" || die "an upstream in $ENV_FILE is not healthy: not deploying"

if [ -n "$OLD" ]; then
  BASELINE=$(snapshot)
  all_ok "$BASELINE" || die "the site is not healthy before the deploy [$BASELINE]: not swapping"
  cert_baseline || die "cannot record the custom-domain certificates the running proxy serves: not swapping"
fi

# A directory whose kind of image has not been running (the other kind ran
# until now, or nothing did) missed every purge in the meantime. Emptying it
# needs no undo if the deploy fails: $OLD never used it.
if [ "$NEW_KIND" != "$OLD_KIND" ]; then
  log "$NEW_IMAGE is a $NEW_KIND cache image${OLD:+, $OLD is $OLD_KIND}: its cache directory may be stale"
  reset_cache_dir "$NEW_CACHE_DIR" "$NEW_IMAGE" || die "cannot empty $NEW_CACHE_DIR"
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
      # With another kind of cache, every purge since $OLD was stopped reached
      # $NEW, which does not share $OLD's cache: start $OLD cold rather than let
      # it serve a page that has changed since.
      if [ "$OLD_KIND" != "$NEW_KIND" ]; then
        reset_cache_dir "$(cache_dir_for "$OLD_KIND")" "$NEW_IMAGE" \
          || log "WARNING: could not empty $(cache_dir_for "$OLD_KIND"): $OLD may serve pages changed since it was stopped"
      fi
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

run_args "$NEW" "$NEW_KIND"
docker create --restart no "${RUN_ARGS[@]}" "$NEW_IMAGE" >/dev/null
docker start "$NEW" >/dev/null

log "Waiting up to ${HEALTH_TIMEOUT}s for $NEW to answer its own health socket"
wait_healthy "$NEW" "$HEALTH_TIMEOUT" || die "$NEW did not become ready in ${HEALTH_TIMEOUT}s"
log "$NEW is ready."

# Health only says nginx is listening. Until a legacy image has rebuilt its
# purge index every /purge returns 503, so do not take traffic (or stop $OLD)
# before that. The disk cache has no index to rebuild.
if [ "$NEW_KIND" = legacy ]; then
  log "Waiting up to ${REHYDRATE_TIMEOUT}s for $NEW to rebuild its purge index"
  wait_rehydrated "$NEW" "$REHYDRATE_TIMEOUT" || die "$NEW did not finish rebuilding its purge index"
  log "$NEW has rebuilt its purge index."
fi

if [ -z "$OLD" ]; then
  # Nothing to compare with, but the site must still answer 200 for every
  # checked host with the right certificate before the container is made permanent.
  log "Checking the site through $NEW"
  live_checks "" || die "checks failed for $NEW_IMAGE"
  certs_all_served || die "$NEW does not serve every custom-domain certificate in Redis"
  docker update --restart unless-stopped "$NEW" >/dev/null
  STATE=committed
  log "$NEW is now serving."
  prune_old_images "$NEW_IMAGE" || true
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

# Remove the old colour for good. -f because it may be running again: the
# per-minute health cron restarts a container that goes unhealthy while it
# drains, and a plain `docker rm` then fails. Left running it would keep taking
# a share of traffic on reuseport. Verify it is gone while the rollback still
# applies: a failure here puts $OLD back and removes $NEW, and says so.
docker rm -f "$OLD" >/dev/null 2>&1 || true
if exists "$OLD" || running "$OLD"; then
  die "could not remove $OLD after the swap: it may be serving alongside $NEW"
fi
STATE=committed
log "Swapped $OLD -> $NEW"
# $OLD's kind of cache stops getting purges now. Empty it so a rollback to
# that kind (possibly by an older blue-green.sh, which resets nothing) does not
# serve it stale; it frees the space too. Best effort: the swap has succeeded.
if [ "$OLD_KIND" != "$NEW_KIND" ]; then
  OLD_CACHE_DIR="$(cache_dir_for "$OLD_KIND")"
  if [ -d "$OLD_CACHE_DIR" ]; then
    reset_cache_dir "$OLD_CACHE_DIR" "$NEW_IMAGE" || log "WARNING: could not empty $OLD_CACHE_DIR: empty it by hand before rolling back to a $OLD_KIND cache image"
  fi
fi
# While both colours were up they did not share a cache, so a purge reached only
# one of them: pages the new colour cached in that time may predate a purge it
# never received. It is the only colour left, so purge everything it holds (a few
# seconds' worth of pages) now that purges reach it.
if [ "$OLD_KIND" != "$NEW_KIND" ]; then
  cached_hosts "$NEW_KIND" "$NEW_CACHE_DIR" "$NEW_IMAGE" | purge_hosts \
    || log "WARNING: could not purge the pages $NEW cached while $OLD was still up: a page purged in that time may be stale until its next purge"
fi
prune_old_images "$NEW_IMAGE" || true
