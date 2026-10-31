#!/usr/bin/env bash
#
# Deploys one stand-in unit image (unit/Dockerfile) over another with the REAL
# blue-green.sh, against real Docker, Redis and a stub upstream, while a load
# generator (swap-load.js) never stops. The deploy replaces the two
# always-running units, blot-blue and then blot-green, one at a time. Every
# deploy goes through this, so any change to the proxy, the deploy scripts or a
# cache is rehearsed the same way:
#
#   1. fresh start with image A (both units); warm its cache
#   2. A -> B under load
#   3. B -> A under load (the rollback)
#   4. A -> B under load again
#   5. B -> A under load: the warm cache is kept; then A again, which must
#      change nothing
#   6. a deploy of B over A that fails after blot-blue was stopped, while the
#      page changes and the proxy is told: blot-blue is put back and must not
#      serve what changed, and blot-green is never touched
#
# Under load means: cached pages (gzip/brotli/identity, HEAD, conditional, Range,
# a 2.5 MB file, a slow fill), uncached GETs, POSTs up to 24 MB, 6-second event
# streams, and a purge about every 500 ms. Every response is checked against
# what the stub upstream would have served (swap-load-lib.js); a swap must
# produce no connection error, no non-2xx/304, no wrong body, no cut event
# stream and no page older than the last finished purge (all the containers
# share one cache directory, so a purge reaches every one). After each swap, with the load
# stopped, every page must be the upstream's current generation and a purge must
# work.
#
# Needs what proxy-deploy-e2e.yml's unit-swap-load-e2e job sets up: the
# harness from setup.sh (STUB_JS=swap-load-stub.js, E2E_UPSTREAMS_FROM_ENV=1),
# unit-setup.sh, and two images, which may be the same build as long as they are
# different images in different repositories (blue-green.sh removes the other
# tags of the repository it deployed; see build-unit-image.sh).
#
#   IMAGE_A, IMAGE_B   the two images (defaults of local.sh: both built from
#                      this checkout, B with one extra label)
#   TCP_MIGRATE_REQ    1 (default): set net.ipv4.tcp_migrate_req=1 first. 0:
#                      leave it, count the connection resets it would have
#                      prevented and report them instead of failing on them
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
: "${IMAGE_A:?}" "${IMAGE_B:?}" "${E2E_ROOT:?}" "${PROXY_DISK_CACHE_DIR:?}" "${BLOT_HOST:?}"

WORK="$E2E_ROOT/swap-load"
rm -rf "$WORK"; mkdir -p "$WORK"
BG="$REPO_ROOT/proxy/deploy/blue-green.sh"
T() { node "$HERE/swap-load.js" "$@"; }
# a run as root: the cache files belong to uid 1000
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
say() { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# blue-green.sh runs in production as a user that is in the docker group and has
# no sudo (the GitHub Deploy workflow's `deploy` user), so it must not
# need root for anything: anything it does to files of uid 1000 (the cache) has
# to go through a container. This runs it as such a user (DEPLOY_AS_ROOT=1: as
# the caller).
DEPLOY_USER=sl-deploy
if [ "${DEPLOY_AS_ROOT:-0}" != 1 ]; then
  echo "t0 $(date +%T)"
  id "$DEPLOY_USER" >/dev/null 2>&1 || { command -v strace >/dev/null || as_root apt-get install -y -qq strace >/dev/null 2>&1; as_root strace -f -tt -T -o /tmp/ua.trace useradd -l -m -G docker "$DEPLOY_USER"; grep -E '<([1-9]|0\.[5-9])[0-9.]*>$' /tmp/ua.trace | cut -c1-200 | head -20; }
  echo "useradd $(date +%T)"
  # the harness' certificate and env files, readable as production's are for its deploy user
  as_root chmod -R a+rX "$E2E_ROOT"
  as_root chmod a+r "$PROXY_CERT_DIR"/*
  d="$E2E_ROOT"; while [ "$d" != / ]; do as_root chmod a+x "$d"; d="$(dirname "$d")"; done
  echo "chmod $(date +%T)"
  ! as_root runuser -u "$DEPLOY_USER" -- sudo -n true >/dev/null 2>&1 || fail "$DEPLOY_USER can sudo: the test would not catch a script that needs it"
  echo "sudo $(date +%T)"
fi
run_bg() {
  if [ "${DEPLOY_AS_ROOT:-0}" = 1 ]; then bash "$BG" "$@"; else local vars; mapfile -t vars < <(env | grep -E '^(PROXY_|BLOT_|ALLOW_STDOUT_LOGS=)')
    # sudo drops the environment, so it is passed on explicitly
    as_root runuser -u "$DEPLOY_USER" -- env "PATH=$PATH" "${vars[@]}" bash "$BG" "$@"; fi
}

# Whole names: a `docker ps --filter name=` is a substring match
proxies() { docker ps -a --format '{{.Names}}' | grep -E '^blot-(blue|green)(-previous)?$' || true; }
assert_units() { # assert_units <image>: blot-blue and blot-green, and only they, run this image
  [ "$(proxies | sort | tr '\n' ' ')" = "blot-blue blot-green " ] || fail "the unit containers are [$(proxies | tr '\n' ' ')], not blot-blue and blot-green"
  local u
  for u in blue green; do
    [ "$(docker inspect -f '{{.State.Running}}' "blot-$u")" = true ] || fail "blot-$u is not running"
    [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "blot-$u")" = unless-stopped ] || fail "blot-$u has the wrong restart policy"
    [ "$(docker inspect -f '{{.Config.Image}}' "blot-$u")" = "$1" ] || fail "blot-$u is not of $1"
  done
}
unit_ids() { docker inspect -f '{{.Id}}' blot-blue blot-green | tr '\n' ' '; }

[ "${IMAGE_A%:*}" != "${IMAGE_B%:*}" ] || fail "IMAGE_A and IMAGE_B are tags of one repository: blue-green.sh removes the other tags of the repository it deploys"
[ "$(docker image inspect -f '{{.Id}}' "$IMAGE_A")" != "$(docker image inspect -f '{{.Id}}' "$IMAGE_B")" ] || fail "IMAGE_A and IMAGE_B are the same image: a swap between them would not be one"

# A container being stopped closes its listening sockets, and with SO_REUSEPORT
# (how the units share :80/:443) a connection that finished its handshake but
# had not been accepted yet is reset. Measured on this harness at ~1000 new
# connections a second: resets in 6 of 10 swaps without the setting below, none
# in 10 with it (the load generator below is slower, and sees one in some 20
# swaps). A kernel since 5.14 hands such connections to the other listener when
# net.ipv4.tcp_migrate_req=1. That is a property of the host kernel, not of the
# deploy scripts: production may not have it. The harness sets it so that CI
# does not flake; TCP_MIGRATE_REQ=0 leaves the host as it is and reports the
# resets (swap-load.js ALLOW_RESETS=1) instead of failing on them.
if [ "${TCP_MIGRATE_REQ:-1}" = 1 ]; then
  if as_root sh -c 'echo 1 > /proc/sys/net/ipv4/tcp_migrate_req' 2>/dev/null; then
    echo "net.ipv4.tcp_migrate_req=$(cat /proc/sys/net/ipv4/tcp_migrate_req)"
  else
    echo "WARNING: cannot set net.ipv4.tcp_migrate_req on this kernel ($(uname -r), it needs 5.14): a swap can reset a connection that was waiting to be accepted; those are counted, not failures" >&2
    export ALLOW_RESETS=1
  fi
else
  echo "net.ipv4.tcp_migrate_req left at $(cat /proc/sys/net/ipv4/tcp_migrate_req 2>/dev/null || echo unknown): connection resets are counted and reported, not failures"
  export ALLOW_RESETS=1
fi
MIGRATE="$(cat /proc/sys/net/ipv4/tcp_migrate_req 2>/dev/null || echo unknown)"

TOTAL_REQUESTS=0 TOTAL_RESETS=0 SUMMARY=""
# A deploy made while a request is mid-flight: start the load, wait for it to
# be running, run blue-green.sh, keep the load going for a few seconds more,
# stop it and read its verdict.
#   swap_under_load <name> <image>
swap_under_load() {
  local name="$1" image="$2" load_pid load_rc=0 bg_rc=0
  rm -f "$WORK/ready"
  READY_FILE="$WORK/ready" node "$HERE/swap-load.js" load > "$WORK/$name.json" 2> "$WORK/$name.err" &
  load_pid=$!
  for _ in $(seq 1 60); do [ -e "$WORK/ready" ] && break; sleep 0.5; done
  [ -e "$WORK/ready" ] || fail "the load generator did not start"
  sleep 5
  run_bg "$image" 2>&1 | tee "$WORK/$name.log" || bg_rc=${PIPESTATUS[0]}
  sleep 5
  kill -TERM "$load_pid"
  wait "$load_pid" || load_rc=$?
  [ -s "$WORK/$name.json" ] || { cat "$WORK/$name.err" >&2; fail "$name: the load generator printed no summary"; }
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`[${process.argv[2]}] ${s.requests} requests in ${s.seconds}s (${JSON.stringify(s.byKind)}),`,
      `${s.sse} event streams, ${s.purges} purges (${s.purgeRetries} retried), ${s.keepAliveRetries} requests reset on an idle kept-alive connection and retried,`, `cache: ${JSON.stringify(s.cache)},`, `slowest ${s.maxMs} ms`);
    console.log(`[${process.argv[2]}] problems:`, JSON.stringify(s.counts), `new connections reset before any response byte: ${s.handshakeResets}`);
    if (s.problems) console.log(JSON.stringify(s.problems, null, 1));
    process.exit(s.requests >= 400 && s.purges >= 5 ? 0 : 3);' "$WORK/$name.json" "$name" || { [ "$?" = 3 ] && fail "$name: too few requests or purges for the run to mean anything"; }
  local n resets
  read -r n resets < <(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(s.requests, s.handshakeResets)' "$WORK/$name.json")
  TOTAL_REQUESTS=$(( TOTAL_REQUESTS + n )); TOTAL_RESETS=$(( TOTAL_RESETS + resets ))
  SUMMARY="$SUMMARY$(printf '\n  %-12s %6s requests, %2s connection resets' "$name" "$n" "$resets")"
  [ "$bg_rc" = 0 ] || fail "$name: blue-green.sh exited $bg_rc"
  [ "$load_rc" = 0 ] || fail "$name: the load generator saw failed or wrong responses (above)"
}

PROBE_K="probe-keep.$BLOT_HOST"
PROBE_F="probe-failed.$BLOT_HOST"

# ---- 1. a fresh start with A -----------------------------------------------
say "1. fresh start with A"
[ -z "$(proxies)" ] || fail "a unit container exists before the test starts"
run_bg "$IMAGE_A" 2>&1 | tee "$WORK/fresh.log"
assert_units "$IMAGE_A"
T warm
T purge-works "b1.$BLOT_HOST"

# ---- 2. A -> B ---------------------------------------------------------------
say "2. A -> B under load"
swap_under_load a-to-b "$IMAGE_B"
assert_units "$IMAGE_B"
T verify-all
T purge-works "b2.$BLOT_HOST"

# ---- 3. B -> A (rollback) ----------------------------------------------------
say "3. B -> A under load (the rollback)"
swap_under_load b-to-a "$IMAGE_A"
assert_units "$IMAGE_A"
T verify-all
T purge-works "b3.$BLOT_HOST"

# ---- 4. A -> B again ---------------------------------------------------------
say "4. A -> B under load again"
swap_under_load a-to-b-again "$IMAGE_B"
assert_units "$IMAGE_B"
T verify-all
T purge-works "b4.$BLOT_HOST"

# ---- 5. B -> A: the warm cache stays; then A again: nothing changes ----------
say "5. B -> A under load: the cache is kept"
T warm
T get "$PROBE_K" /probe >/dev/null; sleep 0.3
KEPT=$(T get "$PROBE_K" /probe)
[ "$(echo "$KEPT" | awk '{print $3}')" = HIT ] || fail "premise: $PROBE_K should be cached"
swap_under_load b-to-a-warm "$IMAGE_A"
assert_units "$IMAGE_A"
AFTER=$(T get "$PROBE_K" /probe)
[ "$AFTER" = "$KEPT" ] || fail "the first request after a redeploy was [$AFTER], wanted the cached [$KEPT]"
T verify-all
T purge-works "b5.$BLOT_HOST"
say "5b. the same image again: neither unit is replaced"
IDS_BEFORE="$(unit_ids)"
run_bg "$IMAGE_A" 2>&1 | tee "$WORK/noop.log"
[ "$(unit_ids)" = "$IDS_BEFORE" ] || fail "a deploy of the image both units run replaced a container"
grep -q "nothing to do" "$WORK/noop.log" || fail "the no-op deploy did not say so"
assert_units "$IMAGE_A"

# ---- 6. a deploy that fails after blot-blue was stopped ---------------------------
say "6. a failed A -> B deploy: blot-blue is put back, blot-green is not touched"
IDS_BEFORE="$(unit_ids)"
T get "$PROBE_F" /probe >/dev/null; sleep 0.3
[ "$(T get "$PROBE_F" /probe | awk '{print $3}')" = HIT ] || fail "the proxy did not cache the probe page"
# Redis down for the whole deploy: nothing before the post-replacement checks
# needs it, and they fail on it (as in proxy-deploy-e2e.yml's unit-deploy-e2e
# job). While blot-blue is replaced a filler requests many distinct pages of
# other hosts. Then, with blot-blue stopped, the pages change and the proxy is
# told: the purge reaches the shared cache, whichever unit takes it.
docker stop blot-e2e-redis >/dev/null
FILL_FILE="$WORK/fill.txt" node "$HERE/swap-load.js" fill ov >/dev/null 2>&1 & fill_pid=$!
sleep 1
run_bg "$IMAGE_B" > "$WORK/failed-swap.log" 2>&1 & failed_pid=$!
for _ in $(seq 1 1500); do grep -q "Checking the site through" "$WORK/failed-swap.log" 2>/dev/null && break; sleep 0.02; done
grep -q "Checking the site through" "$WORK/failed-swap.log" || { cat "$WORK/failed-swap.log"; fail "the deploy never reached its post-replacement checks"; }
kill -TERM "$fill_pid"; wait "$fill_pid" || true
T change "$PROBE_F" >/dev/null
FILL_FILE="$WORK/fill.txt" T change-fill ov >/dev/null
failed_rc=0; wait "$failed_pid" || failed_rc=$?
docker start blot-e2e-redis >/dev/null
for _ in $(seq 1 30); do timeout 2 bash -c "</dev/tcp/127.0.0.1/6379" 2>/dev/null && break; sleep 1; done
cat "$WORK/failed-swap.log"
[ "$failed_rc" != 0 ] || fail "the deploy should have failed with Redis down"
assert_units "$IMAGE_A"
[ "$(unit_ids)" = "$IDS_BEFORE" ] || fail "the failed deploy left a different container behind (blot-blue should be the one that was stopped, put back; blot-green untouched)"
echo "pages the filler cached while the units were up: $(wc -l < "$WORK/fill.txt")"
# the page A had cached before the deploy: purged
T fresh "$PROBE_F" /probe
# the pages cached while blot-blue was being replaced
FILL_STALE=0
FILL_FILE="$WORK/fill.txt" T check-fill ov | tee "$WORK/check-fill.txt" || FILL_STALE=$?
T purge-works "b6.$BLOT_HOST"

say "passed: $TOTAL_REQUESTS requests across four deploys, none failed, wrong or stale; $TOTAL_RESETS new connections reset before a response byte (net.ipv4.tcp_migrate_req=$MIGRATE); a failed deploy put the old container back and left the other unit alone"
printf 'per swap:%s\n' "$SUMMARY"
if [ "$FILL_STALE" != 0 ]; then
  say "FINDING: the container put back after the failed deploy serves pages that changed while it was stopped"
  cat "$WORK/check-fill.txt"
  [ "${ALLOW_FAILED_SWAP_STALE:-0}" = 1 ] || fail "see the finding above (ALLOW_FAILED_SWAP_STALE=1 reports it without failing)"
fi
