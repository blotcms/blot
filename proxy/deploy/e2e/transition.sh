#!/usr/bin/env bash
#
# The first production deploy of the disk cache is a swap from an image with
# the old nginx proxy_cache + cacher.lua ("legacy") to one with diskcache.lua
# ("disk"), on a live host. This runs that with REAL images, the REAL
# blue-green.sh and a load generator that never stops (transition.js), then the
# rollback (disk -> legacy), the swap again, and a redeploy of the same kind:
#
#   1. fresh start with the legacy image; warm its cache
#   2. legacy -> disk  under load
#   3. disk -> legacy  under load (the rollback)
#   4. legacy -> disk  under load (with the stale directories an older
#                      blue-green.sh would have left, see plant_stale)
#   5. disk -> disk    under load: the warm cache survives
#   6. a legacy -> disk swap that fails after the legacy container was stopped,
#                      with a purge only the disk container received
#
# Under load means: cached pages (gzip/brotli/identity, HEAD, conditional, Range,
# a 2.5 MB file, a slow fill), uncached GETs, POSTs up to 24 MB, 6-second event
# streams, and a purge about every 500 ms. Every response is checked against
# what the stub upstream would have served (transition-lib.js); the swap must
# produce no connection error, no non-2xx/304, no wrong body and no page older
# than the last finished purge.
#
# Needs what proxy-deploy-e2e.yml's proxy-transition-e2e job sets up: the
# harness from setup.sh (STUB_JS=transition-stub.js) and the two images.
#
#   IMAGE_LEGACY  image built from a commit that has cacher.lua
#   IMAGE_DISK    image built from this checkout
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
: "${IMAGE_LEGACY:?}" "${IMAGE_DISK:?}" "${E2E_ROOT:?}" "${PROXY_CACHE_DIR:?}" "${PROXY_DISK_CACHE_DIR:?}" "${BLOT_HOST:?}"

WORK="$E2E_ROOT/transition"
rm -rf "$WORK"; mkdir -p "$WORK"
BG="$REPO_ROOT/proxy/deploy/blue-green.sh"
T() { node "$HERE/transition.js" "$@"; }
# a run as root: the cache files belong to uid 1000
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
say() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Files and directories in a cache directory, not counting the .trash a reset
# moves them into (it is deleted in the background)
entries() { as_root find "$1" -mindepth 1 -maxdepth 1 -not -name .trash | wc -l | tr -d ' '; }
assert_empty() { [ "$(entries "$1")" = 0 ] || { as_root ls -la "$1" >&2; fail "$1 was not emptied"; }; }
assert_running() { # assert_running <colour>
  docker ps --format '{{.Names}}' | grep -qx "blot-proxy-$1" || fail "blot-proxy-$1 is not running"
  [ "$(docker ps --format '{{.Names}}' | grep -c '^blot-proxy-')" = 1 ] || fail "more than one proxy container is running"
  [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "blot-proxy-$1")" = unless-stopped ] || fail "blot-proxy-$1 has the wrong restart policy"
}
kind_of() { docker run --rm --entrypoint test "$1" -e /etc/openresty/cacher.lua >/dev/null 2>&1 && echo legacy || echo disk; }

# A container being stopped closes its listening sockets, and with SO_REUSEPORT
# (how both colours share :80/:443) a connection that finished its handshake but
# had not been accepted yet is reset. Measured on this harness at ~1000 new
# connections a second: resets in 6 of 10 swaps without the setting below, none
# in 10 with it (the load generator below is slower, and sees one in some 20
# swaps). A kernel since 5.14 hands such connections to the other listener when
# net.ipv4.tcp_migrate_req=1. That is a property of the host, not of the deploy
# scripts, so the harness sets it; TCP_MIGRATE_REQ=0 leaves it alone to see the
# resets.
if [ "${TCP_MIGRATE_REQ:-1}" = 1 ]; then
  if as_root sh -c 'echo 1 > /proc/sys/net/ipv4/tcp_migrate_req' 2>/dev/null; then
    echo "net.ipv4.tcp_migrate_req=$(cat /proc/sys/net/ipv4/tcp_migrate_req)"
  else
    echo "WARNING: cannot set net.ipv4.tcp_migrate_req on this kernel ($(uname -r), it needs 5.14): a swap can reset a connection that was waiting to be accepted" >&2
  fi
fi

[ "$(kind_of "$IMAGE_LEGACY")" = legacy ] || fail "$IMAGE_LEGACY has no cacher.lua: it is not a legacy image"
[ "$(kind_of "$IMAGE_DISK")" = disk ] || fail "$IMAGE_DISK has cacher.lua: it is not a disk cache image"

# A deploy made while a request is mid-flight: start the load, wait for it to
# be running, run blue-green.sh, keep the load going for a few seconds more,
# stop it and read its verdict.
#   [CROSS_KIND=1] swap_under_load <name> <image>
TOTAL_REQUESTS=0
log_ms() { # log_ms <blue-green.sh log> <text of a line>: that line's time, in epoch milliseconds
  local t; t=$(grep -m1 "$2" "$1" | sed -E 's/^\[([0-9:]+)\].*/\1/')
  [ -n "$t" ] || { echo 0; return; }
  echo $(( $(date -u -d "$(date -u +%F) $t" +%s) * 1000 ))
}
swap_under_load() {
  local name="$1" image="$2" load_pid load_rc=0 bg_rc=0
  : > "$WORK/marks"; rm -f "$WORK/ready"
  MARKS="$WORK/marks" ALLOW_OVERLAP_STALE="${CROSS_KIND:-0}" READY_FILE="$WORK/ready" node "$HERE/transition.js" load > "$WORK/$name.json" 2> "$WORK/$name.err" &
  load_pid=$!
  for _ in $(seq 1 60); do [ -e "$WORK/ready" ] && break; sleep 0.5; done
  [ -e "$WORK/ready" ] || fail "the load generator did not start"
  sleep 5
  bash "$BG" "$image" 2>&1 | tee "$WORK/$name.log" || bg_rc=${PIPESTATUS[0]}
  # both containers were up from when the new one started to when the old one
  # had stopped (the log's one-second stamps, so the generator allows a margin)
  echo "start $(log_ms "$WORK/$name.log" 'Starting blot-proxy-')" >> "$WORK/marks"
  echo "end $(log_ms "$WORK/$name.log" 'Checking the site through')" >> "$WORK/marks"
  sleep 5
  kill -TERM "$load_pid"
  wait "$load_pid" || load_rc=$?
  [ -s "$WORK/$name.json" ] || { cat "$WORK/$name.err" >&2; fail "$name: the load generator printed no summary"; }
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`[${process.argv[2]}] ${s.requests} requests in ${s.seconds}s (${JSON.stringify(s.byKind)}),`,
      `${s.sse} event streams, ${s.purges} purges (${s.purgeRetries} retried), ${s.keepAliveRetries} requests reset on an idle kept-alive connection and retried,`, `cache: ${JSON.stringify(s.cache)},`, `slowest ${s.maxMs} ms`);
    console.log(`[${process.argv[2]}] problems:`, JSON.stringify(s.counts), s.staleInOverlap ? `(plus ${s.staleInOverlap} stale answers while both kinds of container were up, see transition.js)` : "");
    if (s.problems) console.log(JSON.stringify(s.problems, null, 1));
    process.exit(s.requests >= 400 && s.purges >= 5 ? 0 : 3);' "$WORK/$name.json" "$name" || { [ "$?" = 3 ] && fail "$name: too few requests or purges for the run to mean anything"; }
  TOTAL_REQUESTS=$(( TOTAL_REQUESTS + $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).requests)' "$WORK/$name.json") ))
  [ "$bg_rc" = 0 ] || fail "$name: blue-green.sh exited $bg_rc"
  [ "$load_rc" = 0 ] || fail "$name: the load generator saw failed or wrong responses (above)"
}

# blue-green.sh must empty the new kind's directory before the new colour is
# created, and the old kind's once the swap is committed
assert_reset_order() { # assert_reset_order <log> <dir the new kind uses>
  local emptying starting
  emptying=$(grep -n "Emptying $2" "$1" | head -1 | cut -d: -f1)
  starting=$(grep -n "Starting blot-proxy-" "$1" | head -1 | cut -d: -f1)
  [ -n "$emptying" ] || fail "$1 never emptied $2"
  [ "$emptying" -lt "$starting" ] || fail "$2 was emptied after the new container started"
}

# What an OLDER blue-green.sh (one that resets nothing) leaves behind after a
# swap that did reset: the previous contents of the directory that was just
# emptied, back again, stale (the upstream's pages have changed since, and the
# purges since then reached the other kind of cache). The next swap back to
# that kind has to empty it before starting; plus a marker file to find it by.
plant_stale() { # plant_stale <dir> <snapshot taken before the swap>
  as_root cp -a "$2/." "$1/"
  as_root sh -c "echo stale > '$1/STALE-PLANT'"
}

PROBE_L="probe-legacy.$BLOT_HOST"
PROBE_D="probe-disk.$BLOT_HOST"
PROBE_K="probe-keep.$BLOT_HOST"

# ---- 1. a fresh start with the legacy image --------------------------------
say "1. fresh start with the legacy image"
# setup.sh left stale files in both directories
as_root test -e "$PROXY_CACHE_DIR/warm-1" && as_root test -e "$PROXY_DISK_CACHE_DIR/warm-1" || fail "the harness did not seed both cache directories"
bash "$BG" "$IMAGE_LEGACY" 2>&1 | tee "$WORK/fresh.log"
assert_running blue
assert_reset_order "$WORK/fresh.log" "$PROXY_CACHE_DIR"
as_root test ! -e "$PROXY_CACHE_DIR/warm-1" || fail "the legacy directory was not emptied on a fresh start"
as_root test -e "$PROXY_DISK_CACHE_DIR/warm-1" || fail "a legacy start touched the disk cache directory"

T warm
T purge-works "b1.$BLOT_HOST"
# A page the legacy cache holds that the upstream has since changed WITHOUT a
# purge reaching it: whatever serves the site after the swap must not serve it
T get "$PROBE_L" /probe >/dev/null; sleep 0.3
[ "$(T get "$PROBE_L" /probe | awk '{print $3}')" = HIT ] || fail "the legacy cache did not cache the probe page"
T bump "$PROBE_L" >/dev/null
[ "$(T get "$PROBE_L" /probe | awk '{print $3}')" = HIT ] || fail "premise: the legacy cache should still hold the old probe page"
as_root rm -rf "$WORK/snap-legacy"; as_root cp -a "$PROXY_CACHE_DIR" "$WORK/snap-legacy"

# ---- 2. legacy -> disk ------------------------------------------------------
say "2. legacy -> disk under load"
CROSS_KIND=1 swap_under_load legacy-to-disk "$IMAGE_DISK"
assert_running green
assert_reset_order "$WORK/legacy-to-disk.log" "$PROXY_DISK_CACHE_DIR"
grep -q "rehydrate" "$WORK/legacy-to-disk.log" && fail "waited for a rehydrate that a disk image does not do"
as_root test ! -e "$PROXY_DISK_CACHE_DIR/warm-1" || fail "the disk cache directory was not emptied before the disk image started"
assert_empty "$PROXY_CACHE_DIR"
T verify-all
T fresh "$PROBE_L" /probe
T purge-works "b2.$BLOT_HOST"
# an older blue-green.sh would leave the legacy directory as it was
plant_stale "$PROXY_CACHE_DIR" "$WORK/snap-legacy"
# and the disk image caches a page that is then changed with no purge
T get "$PROBE_D" /probe >/dev/null; sleep 0.3
T hit "$PROBE_D" /probe >/dev/null
T bump "$PROBE_D" >/dev/null
T bump "$PROBE_L" >/dev/null
as_root rm -rf "$WORK/snap-disk"; as_root cp -a "$PROXY_DISK_CACHE_DIR" "$WORK/snap-disk"

# ---- 3. disk -> legacy (rollback) --------------------------------------------
say "3. disk -> legacy under load (the rollback)"
CROSS_KIND=1 swap_under_load disk-to-legacy "$IMAGE_LEGACY"
assert_running blue
assert_reset_order "$WORK/disk-to-legacy.log" "$PROXY_CACHE_DIR"
grep -q "rehydrate: complete\|rebuilt its purge index" "$WORK/disk-to-legacy.log" || fail "did not wait for the legacy image to rebuild its purge index"
as_root test ! -e "$PROXY_CACHE_DIR/STALE-PLANT" || fail "the stale legacy directory was not emptied before the legacy image started"
assert_empty "$PROXY_DISK_CACHE_DIR"
T verify-all
T fresh "$PROBE_L" /probe
T purge-works "b3.$BLOT_HOST"
plant_stale "$PROXY_DISK_CACHE_DIR" "$WORK/snap-disk"

# ---- 4. legacy -> disk again ---------------------------------------------------
say "4. legacy -> disk under load, over the stale disk directory"
CROSS_KIND=1 swap_under_load legacy-to-disk-again "$IMAGE_DISK"
assert_running green
assert_reset_order "$WORK/legacy-to-disk-again.log" "$PROXY_DISK_CACHE_DIR"
as_root test ! -e "$PROXY_DISK_CACHE_DIR/STALE-PLANT" || fail "the stale disk directory was not emptied before the disk image started"
assert_empty "$PROXY_CACHE_DIR"
T verify-all
# the page cached by the disk image before the rollback, changed since without a purge
T fresh "$PROBE_D" /probe
T fresh "$PROBE_L" /probe
T purge-works "b4.$BLOT_HOST"

# ---- 5. disk -> disk: the warm cache stays -------------------------------------
say "5. disk -> disk under load: the cache is kept"
T warm
T get "$PROBE_K" /probe >/dev/null; sleep 0.3
KEPT=$(T get "$PROBE_K" /probe)
[ "$(echo "$KEPT" | awk '{print $3}')" = HIT ] || fail "premise: $PROBE_K should be cached"
swap_under_load disk-to-disk "$IMAGE_DISK"
assert_running blue
grep -q "Emptying" "$WORK/disk-to-disk.log" && fail "a redeploy of the same kind emptied a cache directory"
AFTER=$(T get "$PROBE_K" /probe)
[ "$AFTER" = "$KEPT" ] || fail "the first request after a same-kind redeploy was [$AFTER], wanted the cached [$KEPT]"
T verify-all
T purge-works "b5.$BLOT_HOST"

# ---- 6. a legacy -> disk swap that fails after the old container was stopped ---
say "6. a failed legacy -> disk swap: the legacy container is put back"
bash "$BG" "$IMAGE_LEGACY" 2>&1 | tee "$WORK/to-legacy.log"
assert_running "$(docker ps --format '{{.Names}}' | grep '^blot-proxy-' | sed 's/blot-proxy-//')"
PROBE_F="probe-failed.$BLOT_HOST"
T get "$PROBE_F" /probe >/dev/null; sleep 0.3
[ "$(T get "$PROBE_F" /probe | awk '{print $3}')" = HIT ] || fail "the legacy cache did not cache the probe page"
# Redis down for the whole deploy: nothing before the post-swap checks needs it,
# and they fail on it (as in proxy-deploy-e2e.yml's forced-failure step). The
# page changes, and the proxy is told, while the legacy container is stopped:
# the purge can only reach the disk container.
docker stop blot-e2e-redis >/dev/null
bash "$BG" "$IMAGE_DISK" > "$WORK/failed-swap.log" 2>&1 & failed_pid=$!
for _ in $(seq 1 120); do grep -q "Checking the site through" "$WORK/failed-swap.log" 2>/dev/null && break; sleep 0.1; done
grep -q "Checking the site through" "$WORK/failed-swap.log" || { cat "$WORK/failed-swap.log"; fail "the swap never reached its post-swap checks"; }
T change "$PROBE_F" >/dev/null
failed_rc=0; wait "$failed_pid" || failed_rc=$?
docker start blot-e2e-redis >/dev/null
for _ in $(seq 1 30); do timeout 2 bash -c "</dev/tcp/127.0.0.1/6379" 2>/dev/null && break; sleep 1; done
cat "$WORK/failed-swap.log"
[ "$failed_rc" != 0 ] || fail "the swap should have failed with Redis down"
assert_running "$(docker ps --format '{{.Names}}' | grep '^blot-proxy-' | sed 's/blot-proxy-//')"
[ "$(docker inspect -f '{{.Config.Image}}' "$(docker ps --format '{{.Names}}' | grep '^blot-proxy-')")" = "$IMAGE_LEGACY" ] || fail "the legacy container was not put back"
# it missed the purge: nothing it cached before it was stopped may be served now
T fresh "$PROBE_F" /probe
T purge-works "b6.$BLOT_HOST"

say "passed: $TOTAL_REQUESTS requests across four swaps, none failed or wrong; a failed swap rolled back clean"
