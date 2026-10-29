#!/usr/bin/env bash
#
# Deploy a proxy IMAGE to the two proxy containers, blot-blue and blot-green,
# one at a time, while the other carries all the traffic.
#
#   proxy/deploy/blue-green.sh <commit-sha | image>
#
# Run it on the production host. Both containers are always running (the names
# are final: the Node containers will move inside them in a later stage), and
# both are replaced by every deploy, blue first. For a config-only change,
# deploy a new image the same way (reload-config.sh needs a bind-mounted conf
# dir, which these scripts' containers do not have).
#
# How it works
# ------------
# The containers run with `--network host`. The generated config sets
# `reuseport` on :80 and :443, so both proxies listen on the same ports and the
# kernel spreads new connections over the ones that are up. A unit is replaced
# by stopping it (entrypoint.sh runs `openresty -s quit`, so in-flight requests
# finish within the drain timeout) while the other one answers everything, then
# starting the new one under the same name. See proxy/README.md "Deployment".
#
# What the host looks like decides what the script does:
#
#   steady     blot-blue and blot-green are running. For blue, then green:
#                1. refuse unless the OTHER unit is running and healthy (the
#                   last healthy proxy is never stopped);
#                2. skip the unit if it already runs this image and is healthy,
#                   so running a deploy twice is safe;
#                3. stop it, rename it blot-<unit>-previous (kept, stopped, for
#                   the rollback), create and start the new blot-<unit>, wait
#                   for its health socket, check the site;
#                4. on any failure the new one is removed and the previous one
#                   is started again and renamed back, and the deploy stops:
#                   the other unit is never touched;
#                5. on success the new one gets its restart policy and the
#                   previous one is removed.
#   partial    only one unit is running (a crash, an earlier failed deploy):
#              the missing one is started first, beside the running one, and
#              checked like a new unit in the transition; then as steady.
#   legacy     one blot-proxy-blue or blot-proxy-green is running (the single
#              proxy of before the two units), and neither unit. blot-blue and
#              blot-green are started beside it, each checked; then the legacy
#              proxy is stopped, the site checked once more, and it is removed.
#              Any failure removes what was started and leaves the legacy
#              proxy running.
#   fresh      no proxy is running: both units are started (blue first), the
#              site must answer 200 with the right certificate and every
#              custom domain must present its own certificate before each is
#              made permanent. The cache directory is emptied first.
#
# A new container is created with restart policy `no`, so a half-checked one is
# never restarted by Docker, and gets `unless-stopped` only once it passed (in
# the legacy transition, before the legacy proxy is stopped, so a daemon
# restart in between still leaves proxies). Everything after the first change
# runs under a trap: any failure or interrupt undoes it.
#
# The checks (live_checks) go to the host's :443, which either unit may
# answer, so on their own they say little about the container just started
# while the other is serving. What proves the new container is its own health
# socket (docker exec ... --unix-socket), which only that container answers,
# and the stop of the old unit before the checks, which leaves just the other
# healthy unit and the new one to answer them.
#
# Names: Docker's `--filter name=` is a substring regex, so every lookup here
# lists the names and compares them whole (running/exists in common.sh).
#
# Cache directory: every container mounts $DISK_CACHE_DIR at
# /var/cache/openresty and they all share it, so a purge reaching either one
# purges both and a deploy keeps the warm cache. On a fresh start (nothing
# running) the directory is emptied first, because it missed every purge since
# it was last in use. See proxy/deploy/README.md "Cache directory".
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

# ---- what is running -------------------------------------------------------
LEGACY=""
for c in $LEGACY_PROXIES; do
  if running "$c"; then
    # e.g. a rollback that kept the new one because the old one would not come
    # back: by name alone we might remove the one that is actually healthy.
    [ -z "$LEGACY" ] || die "$LEGACY and $c are both running: stop the unhealthy one by hand first"
    LEGACY="$c"
  fi
done
UP="" DOWN=""
for u in $UNITS; do
  if running "$(unit_name "$u")"; then UP="$UP $u"; else DOWN="$DOWN $u"; fi
done
UP="${UP# }"; DOWN="${DOWN# }"

if [ -n "$LEGACY" ]; then
  [ -z "$UP" ] || die "$LEGACY and the unit(s) [$UP] are running together: an earlier transition did not finish. Stop and remove $LEGACY or the units by hand first"
  MODE=legacy
elif [ -z "$UP" ]; then
  MODE=fresh
  # Legacy guard. Production's bare-metal OpenResty has been uninstalled, so
  # this is not a normal state; it protects a host that still has an
  # `openresty` unit, which binds :80/:443 without reuseport (the container
  # cannot share them) and would race the container for them after a reboot.
  if sys systemctl is-active --quiet openresty || sys systemctl is-enabled --quiet openresty; then
    die "this host still has an active or enabled legacy bare-metal 'openresty' systemd unit, which would conflict with the container for :80/:443 (and race it after a reboot): stop and disable it first (sudo systemctl disable --now openresty)"
  fi
  log "No proxy container running - starting $(unit_name blue) and $(unit_name green) fresh."
elif [ -n "$DOWN" ]; then
  MODE=partial
  log "Only [$UP] is running - starting [$DOWN] first."
else
  MODE=steady
fi

# A previous container left by a deploy that was killed. If its unit is running
# and healthy it is just litter; if not, it is the unit that should be there.
for u in $UNITS; do
  prev="$(unit_name "$u")-previous"
  exists "$prev" || continue
  if running "$(unit_name "$u")" && healthy "$(unit_name "$u")"; then
    log "Removing $prev, left by an earlier deploy"
    docker stop --time "$DRAIN_TIMEOUT" "$prev" >/dev/null 2>&1 || true
    docker rm -f "$prev" >/dev/null 2>&1 || true
    ! exists "$prev" || die "cannot remove $prev"
  else
    die "$prev exists and $(unit_name "$u") is not running and healthy: a deploy was interrupted. Put the old one back by hand (docker rm -f $(unit_name "$u"); docker rename $prev $(unit_name "$u"); docker start $(unit_name "$u"))"
  fi
done

log "Preflight ($MODE)"
ensure_image "$NEW_IMAGE"
NEW_IMAGE_ID="$(image_id "$NEW_IMAGE")"
[ -d "$DISK_CACHE_DIR" ] \
  || die "cache directory $DISK_CACHE_DIR does not exist: create it with: sudo install -d -o 1000 -g 1000 $DISK_CACHE_DIR"
report=$(validate_image "$NEW_IMAGE") \
  || { echo "$report" >&2; die "$NEW_IMAGE does not render a valid config with $ENV_FILE"; }
if [ "${ALLOW_STDOUT_LOGS:-}" != "1" ]; then
  image_logs_to_file "$NEW_IMAGE" \
    || die "$NEW_IMAGE logs to stdout, so fail2ban would see nothing. Build with LOG_TO_STDOUT=false (ALLOW_STDOUT_LOGS=1 to override)"
fi

# Before a new container takes any traffic: a wrong or missing PROXY_UPSTREAM_*
# (e.g. a unix: socket path) would otherwise only show after a unit is stopped
wait_upstreams_reachable "$UPSTREAM_WAIT" || die "an upstream in $ENV_FILE is not healthy: not deploying"

if [ "$MODE" != fresh ]; then
  BASELINE=$(snapshot)
  all_ok "$BASELINE" || die "the site is not healthy before the deploy [$BASELINE]: not deploying"
  cert_baseline || die "cannot record the custom-domain certificates the running proxy serves: not deploying"
fi

# With nothing running the cache directory missed every purge since it was last
# used. Emptying it needs no undo if the deploy fails: nothing used it.
if [ "$MODE" = fresh ]; then
  reset_cache_dir "$DISK_CACHE_DIR" "$NEW_IMAGE" || die "cannot empty $DISK_CACHE_DIR"
fi

# ---- undo ------------------------------------------------------------------
# From the first change every exit before the end (a failed check, Ctrl-C, a
# failed docker command) must undo what was done. What there is to undo:
#   STARTED     containers created by this run that are not yet permanent
#   STOPPED     the legacy proxy, stopped for the transition: start it again
#   SWAP        the unit being replaced, and how far it got (SWAP_STATE):
#     stopped     it is stopped under its own name: start it again
#     renamed     it is blot-<unit>-previous and the new one may exist as
#                 blot-<unit>: start the old one, remove the new, rename back
STARTED="" STOPPED="" SWAP="" SWAP_STATE=""

remove_container() { # remove_container <name>, with the end of its log
  docker logs --tail 50 "$1" >&2 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
}

swap_back() {
  local name="$SWAP" prev="$SWAP-previous"
  if [ "$SWAP_STATE" = stopped ]; then
    log "Putting $name back"
    if ! { docker start "$name" >/dev/null 2>&1 && wait_healthy "$name" "$HEALTH_TIMEOUT"; }; then
      log "WARNING: $name did not come back healthy. The other unit is still serving: sort it out by hand"
    fi
    return
  fi
  log "Putting $prev back and removing the new $name"
  # The new one may be the only unit answering if the old one cannot come back,
  # so it is removed only once the old one is up and healthy (it is started
  # under its -previous name, as the name $name is taken). The cache directory
  # is shared, so every purge since it was stopped reached it too.
  if docker start "$prev" >/dev/null 2>&1 && wait_healthy "$prev" "$HEALTH_TIMEOUT"; then
    if exists "$name"; then remove_container "$name"; fi
    docker rename "$prev" "$name" >/dev/null 2>&1 \
      || log "WARNING: could not rename $prev back to $name: it is running as $prev, sort it out by hand"
  else
    docker stop --time "$DRAIN_TIMEOUT" "$prev" >/dev/null 2>&1 || true
    if exists "$name" && healthy "$name"; then
      log "WARNING: $prev did not come back healthy. Keeping the new $name running (it may be the only $SWAP proxy serving): sort it out by hand"
    else
      log "WARNING: $prev did not come back healthy and the new $name is not healthy either. Removing $name and leaving the old one stopped as $name: sort it out by hand"
      if exists "$name"; then remove_container "$name"; fi
      docker rename "$prev" "$name" >/dev/null 2>&1 || true
    fi
  fi
}

restore_stopped() {
  log "Starting $STOPPED again"
  if docker start "$STOPPED" >/dev/null 2>&1 && wait_healthy "$STOPPED" "$HEALTH_TIMEOUT"; then
    local c
    for c in $STARTED; do remove_container "$c"; done
  else
    log "WARNING: $STOPPED did not come back healthy. Keeping what was started ($STARTED) (it may be the only proxy serving): sort it out by hand"
  fi
}

deploy_rollback() {
  local status=$?
  if [ -n "$SWAP_STATE" ]; then
    log "Replacing $SWAP failed or was interrupted (exit $status)"
    swap_back
  elif [ -n "$STOPPED" ]; then
    log "Transition failed or interrupted (exit $status): putting $STOPPED back"
    restore_stopped
  elif [ -n "$STARTED" ]; then
    log "Failed or interrupted before anything was stopped (exit $status): removing $STARTED"
    local c
    for c in $STARTED; do remove_container "$c"; done
  fi
  exit "$status"
}
trap deploy_rollback EXIT
trap 'exit 130' INT TERM
trap '' HUP PIPE

# ---- steps -----------------------------------------------------------------
# bring_up <name>: create, start and wait for the container's own health
# socket. Restart policy `no` until it has passed (see the top).
bring_up() {
  log "Starting $1 from $NEW_IMAGE"
  run_args "$1"
  docker create --restart no "${RUN_ARGS[@]}" "$NEW_IMAGE" >/dev/null
  docker start "$1" >/dev/null
  log "Waiting up to ${HEALTH_TIMEOUT}s for $1 to answer its own health socket"
  wait_healthy "$1" "$HEALTH_TIMEOUT" || die "$1 did not become ready in ${HEALTH_TIMEOUT}s"
  log "$1 is ready."
}

# start_unit <unit> <fresh|beside>: a unit that is not there yet, started next
# to whatever proxies exist. `fresh`: nothing to compare with, but the site must
# still answer 200 for every checked host with the right certificate, and every
# custom domain must present a certificate of its own, before it is made
# permanent. `beside`: the site must answer as it did before.
start_unit() {
  local name; name="$(unit_name "$1")"
  docker rm -f "$name" >/dev/null 2>&1 || true # a stopped one left behind
  STARTED="$STARTED $name"
  bring_up "$name"
  log "Checking the site through $name"
  if [ "$2" = fresh ]; then
    live_checks "" || die "checks failed for $NEW_IMAGE"
    certs_all_served || die "$name does not serve every custom-domain certificate in Redis"
  else
    live_checks "$BASELINE" || die "checks failed after starting $name from $NEW_IMAGE"
  fi
}

# replace_unit <unit>: stop the running unit, keep it as -previous, start the
# new one in its name. The other unit must be running and healthy.
replace_unit() {
  local u="$1" name other prev
  name="$(unit_name "$u")"; other="$(unit_name "$(other_unit "$u")")"; prev="$name-previous"
  if running "$name" && [ "$(container_image_id "$name")" = "$NEW_IMAGE_ID" ] && healthy "$name"; then
    log "$name already runs $NEW_IMAGE and is healthy: nothing to do"
    return 0
  fi
  if ! { running "$other" && healthy "$other"; }; then
    die "$other is not running and healthy: refusing to stop $name, it would leave no proxy"
  fi

  log "Replacing $name: draining and stopping it (timeout ${DRAIN_TIMEOUT}s), $other carries the traffic"
  SWAP="$name" SWAP_STATE=stopped
  docker stop --time "$DRAIN_TIMEOUT" "$name" >/dev/null
  docker rename "$name" "$prev"
  SWAP_STATE=renamed
  bring_up "$name"

  log "Checking the site through $name and $other"
  live_checks "$BASELINE" || die "checks failed after replacing $name with $NEW_IMAGE"

  # Only now, so a daemon restart before this leaves $other running and not an
  # unchecked container; a unit that failed never gets a restart policy.
  docker update --restart unless-stopped "$name" >/dev/null

  # Remove the previous one for good. -f because it may be running again: the
  # per-minute health cron restarts a container that goes unhealthy while it
  # drains, and a plain `docker rm` then fails. Left running it would keep
  # taking a share of traffic on reuseport. Verify it is gone while the
  # rollback still applies: a failure here puts it back and removes the new one.
  docker rm -f "$prev" >/dev/null 2>&1 || true
  if exists "$prev" || running "$prev"; then
    die "could not remove $prev after replacing $name: it may be serving alongside it"
  fi
  SWAP="" SWAP_STATE=""
  log "Replaced $name"
}

# ---- the deploy ------------------------------------------------------------
case "$MODE" in
  fresh)
    for u in $UNITS; do
      start_unit "$u" fresh
      docker update --restart unless-stopped "$(unit_name "$u")" >/dev/null
      # permanent: a later failure leaves this one running
      STARTED="${STARTED/ $(unit_name "$u")/}"
      log "$(unit_name "$u") is now serving."
    done
    ;;
  legacy)
    for u in $UNITS; do start_unit "$u" beside; done
    # Restartable BEFORE the legacy proxy is stopped: a container that was
    # stopped by hand is not restarted, so between the stop and a later policy
    # change a daemon restart would leave nothing running. If this fails the
    # legacy proxy is untouched and the trap removes what was started.
    for c in $STARTED; do docker update --restart unless-stopped "$c" >/dev/null; done
    log "Draining and stopping $LEGACY (timeout ${DRAIN_TIMEOUT}s)"
    STOPPED="$LEGACY"
    docker stop --time "$DRAIN_TIMEOUT" "$LEGACY" >/dev/null
    log "Checking the site through $(unit_name blue) and $(unit_name green)"
    live_checks "$BASELINE" || die "checks failed after stopping $LEGACY"
    # -f because the health cron may have restarted it while it drained
    docker rm -f "$LEGACY" >/dev/null 2>&1 || true
    if exists "$LEGACY" || running "$LEGACY"; then
      die "could not remove $LEGACY after the transition: it may be serving alongside the units"
    fi
    STARTED="" STOPPED=""
    log "Replaced $LEGACY with $(unit_name blue) and $(unit_name green)"
    ;;
  *)
    for u in $DOWN; do
      start_unit "$u" beside
      docker update --restart unless-stopped "$(unit_name "$u")" >/dev/null
      STARTED="${STARTED/ $(unit_name "$u")/}"
    done
    for u in $UNITS; do replace_unit "$u"; done
    ;;
esac

prune_old_images "$NEW_IMAGE" || true
log "Done: $(unit_name blue) and $(unit_name green) run $NEW_IMAGE"
