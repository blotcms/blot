#!/bin/sh
# Samples the memory of each app container and the host into
# /var/instance-ssd/logs/unit-mem.log, to size the host from long-run peaks
# (blotcms/blot#2261). The log is on the instance store, so unlike the
# `[STATS] process_rss=` line in container logs it survives deploys.
#
# Run by /etc/cron.d/blot-unit-mem as root, once a minute. One run takes 4
# samples 15 seconds apart and then exits, so a run never overlaps the next
# (flock guards against it anyway). Child processes (pandoc, git, exiftool)
# spike for seconds, which is why a minute between samples is too coarse.
#
# One line per container per sample:
#   2026-10-30T07:20:15Z name=blot-blue anon=B file=B shmem=B limit=B oom_kill=N \
#     node_max=B node_sum=B top=comm:B
# anon+shmem is the memory that cannot be reclaimed; the cgroup limit also
# counts page cache (file), so usage against limit overstates the need.
# node_max is the biggest node process (node_sum can't tell one from two);
# top is the biggest process that is not node/nginx/openresty/tini/sh/su-exec
# ("-" if none), i.e. the child-process spike. limit=0 means unlimited. Plus
# one `name=host mem_available mem_total swap_used` line per sample.
# Works on cgroup v1 (Amazon Linux 2) and v2 (Amazon Linux 2023).
# Read it with unit-mem-summary.sh.
#
# The paths and counts below can be overridden by env vars for testing.
LOG="${UNIT_MEM_LOG:-/var/instance-ssd/logs/unit-mem.log}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
PROC="${PROC:-/proc}"
DOCKER="${DOCKER:-docker}"
SAMPLES="${SAMPLES:-4}"
INTERVAL="${INTERVAL:-15}"
CONTAINERS="${CONTAINERS:-blot-blue blot-green blot-blue-airlock blot-green-airlock}"

# Cron mails any output, so stay quiet; a missing log directory means the
# instance store isn't mounted, which is not ours to fix.
exec 2> /dev/null
[ -d "$(dirname "$LOG")" ] || exit 0

if command -v flock > /dev/null; then
  exec 9> "${LOG}.lock"
  flock -n 9 || exit 0
fi

# Trim only in the first run of the hour. Keep about 30 days of samples
# (20 lines a minute is about 860,000).
trim=0
[ "$(date -u +%M)" = 00 ] && trim=1

if [ -e "$CGROUP_ROOT/cgroup.controllers" ]; then V=2; else V=1; fi

# Resolve each container's cgroup directory once per run. A container that
# doesn't exist or is mid-restart is skipped.
targets=""
for name in $CONTAINERS; do
  id=$($DOCKER inspect -f '{{.Id}}' "$name") || continue
  [ -n "$id" ] || continue
  for dir in \
    "$CGROUP_ROOT/system.slice/docker-$id.scope" "$CGROUP_ROOT/docker/$id" \
    "$CGROUP_ROOT/memory/docker/$id" "$CGROUP_ROOT/memory/system.slice/docker-$id.scope"; do
    if [ -r "$dir/memory.stat" ]; then targets="$targets $name=$dir"; break; fi
  done
done

# Prints the VmRSS of a pid in bytes; nothing if it has gone.
rss() {
  while read -r key value _; do
    if [ "$key" = "VmRSS:" ]; then echo $((value * 1024)); return; fi
  done < "$PROC/$1/status"
}

# Prints the key=value fields for the container whose cgroup is in $1.
container_fields() {
  dir=$1
  # A deploy can remove the container between samples: skip it, or the line
  # would have empty fields
  [ -r "$dir/memory.stat" ] || return 1
  if [ "$V" = 2 ]; then
    set -- $(awk '$1 == "anon" {a = $2} $1 == "file" {f = $2} $1 == "shmem" {s = $2}
      END {print a + 0, f + 0, s + 0}' "$dir/memory.stat")
    limit=$(cat "$dir/memory.max"); oom=$(awk '$1 == "oom_kill" {print $2}' "$dir/memory.events")
  else
    set -- $(awk '$1 == "total_rss" {a = $2} $1 == "total_cache" {f = $2} $1 == "total_shmem" {s = $2}
      END {print a + 0, f + 0, s + 0}' "$dir/memory.stat")
    limit=$(cat "$dir/memory.limit_in_bytes"); oom=$(awk '$1 == "oom_kill" {print $2}' "$dir/memory.oom_control")
  fi
  # "max" (v2) or a huge number (v1, 2^63 less a page) means unlimited
  case "$limit" in *[!0-9]* | "") limit=0 ;; esac
  [ "${#limit}" -ge 16 ] && limit=0
  node_max=0 node_sum=0 top_comm="-" top_rss=0
  for pid in $(cat "$dir/cgroup.procs"); do
    comm=""; read -r comm < "$PROC/$pid/comm" || continue
    bytes=$(rss "$pid"); [ -n "$bytes" ] || continue
    case "$comm" in
      node) node_sum=$((node_sum + bytes)); [ "$bytes" -gt "$node_max" ] && node_max=$bytes ;;
      nginx | openresty | tini | sh | su-exec) ;;
      *) if [ "$bytes" -gt "$top_rss" ]; then
           top_rss=$bytes; top_comm=$(printf %s "$comm" | tr ' ' _)
         fi ;;
    esac
  done
  echo "anon=$1 file=$2 shmem=$3 limit=$limit oom_kill=${oom:-0}" \
    "node_max=$node_max node_sum=$node_sum top=$top_comm:$top_rss"
}

sample=0
while [ "$sample" -lt "$SAMPLES" ]; do
  [ "$sample" -gt 0 ] && sleep "$INTERVAL"
  sample=$((sample + 1))
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  out=""
  for target in $targets; do
    fields=$(container_fields "${target#*=}") || continue
    [ -n "$fields" ] && out="$out$now name=${target%%=*} $fields
"
  done
  host=$(awk '$1 == "MemTotal:" {t = $2} $1 == "MemAvailable:" {a = $2}
    $1 == "SwapTotal:" {st = $2} $1 == "SwapFree:" {sf = $2}
    END {printf "mem_available=%.0f mem_total=%.0f swap_used=%.0f", a * 1024, t * 1024, (st - sf) * 1024}' "$PROC/meminfo")
  out="$out$now name=host $host
"
  printf %s "$out" >> "$LOG"
done

if [ "$trim" = 1 ] && [ "$(wc -l < "$LOG")" -gt 900000 ]; then
  tail -n 860000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0
