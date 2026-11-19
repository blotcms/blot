#!/bin/bash
# Runs config/host/scripts/unit-mem-log.sh against a fake /proc and a fake
# cgroup v2 tree (the PROC and CGROUP_ROOT overrides) and a stub docker, then
# unit-mem-summary.sh on the log it wrote. Needs no docker.
#
# Usage: config/host/tests/unit-mem.sh
set -euo pipefail

SCRIPTS=$(cd "$(dirname "$0")/../scripts" && pwd)
FAILED=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then ok "$what"; else fail "$what"; fi
}

PROC=$TMP/proc
CG=$TMP/cgroup
ID=abc123
DIR=$CG/system.slice/docker-$ID.scope
mkdir -p "$PROC" "$DIR"
touch "$CG/cgroup.controllers"
printf 'anon 1048576\nfile 2097152\nshmem 0\n' > "$DIR/memory.stat"
echo 1073741824 > "$DIR/memory.max"
echo 4194304 > "$DIR/memory.peak"
echo "oom_kill 0" > "$DIR/memory.events"
printf 'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' > "$PROC/meminfo"

printf '#!/bin/sh\necho %s\n' "$ID" > "$TMP/docker"
chmod +x "$TMP/docker"

# proc <pid> <comm> <rss kB> <cmdline, words separated by spaces> [environ line]
: > "$DIR/cgroup.procs"
proc() {
  mkdir -p "$PROC/$1"
  echo "$1" >> "$DIR/cgroup.procs"
  echo "$2" > "$PROC/$1/comm"
  printf 'VmRSS:\t%s kB\n' "$3" > "$PROC/$1/status"
  printf '%s' "$4" | tr ' ' '\0' > "$PROC/$1/cmdline"
  printf '%s\0' "${5:-X=1}" > "$PROC/$1/environ"
}
proc 10 node 1000 'node app/index.js'
proc 11 node 2000 'node app/index.js' 'BLOT_WORKER_CHILD=true'
proc 12 node 300 'node /usr/local/lib/blot-sandbox/broker.js'
proc 14 MainThread 50 'node scripts/some/script.js'
proc 20 nginx 10 'nginx: master process'
proc 21 nginx 20 'nginx: worker process'
proc 22 nginx 30 'nginx: worker process'
proc 30 git 7 'git status'
proc 31 pandoc 90 'pandoc x'
proc 40 tini 1 'tini --'

# A stub redis-cli that records its arguments, one per line
printf '#!/bin/sh\nprintf "%%s\\n" "$@" > "%s/redis-args"\n' "$TMP" > "$TMP/redis-cli"
chmod +x "$TMP/redis-cli"

LOG=$TMP/unit-mem.log
run() {
  UNIT_MEM_LOG=$LOG PROC=$PROC CGROUP_ROOT=$CG DOCKER=$TMP/docker REDIS_CLI=$TMP/redis-cli \
    SAMPLES=2 INTERVAL=0 CONTAINERS=blot-blue "$SCRIPTS/unit-mem-log.sh"
}
check "the sampler exits cleanly" run

check "the latest sample is stored in Redis" test "$(sed -n 1,2p "$TMP/redis-args" | tr '\n' ' ')" = "SET blot:unit-mem:latest "
check "the stored value has the alerting fields for the container" \
  grep -Eq '^[0-9TZ:-]+ name=blot-blue anon=1048576 shmem=0 limit=1073741824 oom_kill=0$' "$TMP/redis-args"
check "the stored value is one sample, not the log" test "$(grep -c ' name=blot-blue ' "$TMP/redis-args")" = 1

# line <field>: that field of the first blot-blue line
field() { grep ' name=blot-blue ' "$LOG" | head -1 | tr ' ' '\n' | grep "^$1=" | cut -d= -f2-; }
bytes() { echo $(($1 * 1024)); }

check "two samples were taken" test "$(grep -c ' name=blot-blue ' "$LOG")" = 2
check "node_a is the app process" test "$(field node_a)" = "$(bytes 1000)"
check "node_b is the worker child" test "$(field node_b)" = "$(bytes 2000)"
check "broker is the sandbox broker" test "$(field broker)" = "$(bytes 300)"
check "proxy is retired and reads 0" test "$(field proxy)" = 0
check "node_other is only the exec'd script" test "$(field node_other)" = "$(bytes 50)"
check "node_sum still counts every node" test "$(field node_sum)" = "$(bytes 3350)"
check "openresty sums the nginx processes" test "$(field openresty)" = "$(bytes 60)"
check "openresty_n counts them" test "$(field openresty_n)" = 3
check "git is unchanged" test "$(field git_n)" = 1
check "top is the child-process spike" test "$(field top)" = "pandoc:$(bytes 90)"
check "peak is kept" test "$(field peak)" = 4194304
check "the new fields come after the old ones" \
  test "$(grep ' name=blot-blue ' "$LOG" | head -1 | sed 's/.* top=[^ ]* //')" = \
  "peak=4194304 broker=$(bytes 300) proxy=0 openresty=$(bytes 60) openresty_n=3"

# An old line has none of the new fields; the summary has to take both.
echo "2026-11-01T00:00:00Z name=blot-blue anon=1 file=1 shmem=0 limit=0 oom_kill=0 node_max=1 node_sum=1 node_a=1 node_b=0 node_other=0 git=0 git_n=0 top=-:0" >> "$LOG"

OUT=$TMP/summary.txt
UNIT_MEM_OLD=$TMP/none "$SCRIPTS/unit-mem-summary.sh" "$LOG" > "$OUT"
check "the summary reports the new fields" \
  grep -q 'broker max 0 MiB p99 0 MiB, proxy jail max 0 MiB p99 0 MiB, openresty max 0 MiB p99 0 MiB in up to 3 processes' "$OUT"
check "the summary counts every line" grep -q '^blot-blue: 3 samples' "$OUT"

# Bigger values, so MiB are not all zero.
BIG=$TMP/big.log
for b in 100 300 200; do
  echo "2026-11-02T00:00:00Z name=blot-blue anon=1 file=1 shmem=0 limit=0 oom_kill=0 node_max=1 node_sum=1 node_a=1 node_b=0 node_other=0 git=0 git_n=0 top=-:0 broker=$((b * 1048576)) proxy=$((b * 2097152)) openresty=$((b * 524288)) openresty_n=$((b / 100))" >> "$BIG"
done
UNIT_MEM_OLD=$TMP/none "$SCRIPTS/unit-mem-summary.sh" "$BIG" > "$OUT"
check "broker max and p99" grep -q 'broker max 300 MiB p99 200 MiB' "$OUT"
check "proxy max" grep -q 'proxy jail max 600 MiB' "$OUT"
check "openresty max and process count" grep -q 'openresty max 150 MiB p99 100 MiB in up to 3 processes' "$OUT"

# With no argument the summary also reads the daily copies, oldest first.
OLD=$TMP/old
mkdir "$OLD"
echo "2026-10-01T00:00:00Z name=blot-blue anon=1 file=1 shmem=0 limit=0 oom_kill=0 node_max=1 node_sum=1 node_a=1 node_b=0 node_other=0 git=0 git_n=0 top=-:0" | gzip > "$OLD/unit-mem.log-20261001.gz"
UNIT_MEM_LOG=$LOG UNIT_MEM_OLD=$OLD "$SCRIPTS/unit-mem-summary.sh" > "$OUT"
check "the daily copies are read too" grep -q '^blot-blue: 4 samples, 2026-10-01T00:00:00Z' "$OUT"

exit "$FAILED"
