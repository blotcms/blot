#!/bin/sh
# Summarises unit-mem.log (written by unit-mem-log.sh): for each container the
# sample count, first and last sample, max and p99 of anon+shmem (the memory
# that can't be reclaimed), max node_max, the max of node-a, node-b, any other
# node (docker exec scripts), the sandbox broker, the retired sandbox proxy jail (old lines only),
# OpenResty's summed RSS with its most processes, and git's summed RSS with its
# most processes at once (each where the log has them), max oom_kill, the cgroup's peak where
# it has one, and the five non-node processes with the highest peak RSS; and
# the host's lowest mem_available. Where lines have them, it also adds up how
# much the limit squeezed the page cache over the window: file pages read
# back in, time waiting on memory and times at the limit. Those counters are
# cumulative per container, so it sums their rises, starting again when a new
# container's counter restarts lower. For blot-sandbox-<unit> lines (the units'
# sandbox jobs) peak and oom_kill are the numbers to read, against limit.
# With no argument it reads the live log and the daily copies logrotate keeps
# in /var/lib/blot-unit-mem (oldest first), so it reaches back before a reboot.
# Read-only. Usage: unit-mem-summary.sh [logfile]
LOG="${1:-${UNIT_MEM_LOG:-/var/instance-ssd/logs/unit-mem.log}}"
OLD="${UNIT_MEM_OLD:-/var/lib/blot-unit-mem}"
VALUES=$(mktemp) || exit 1
trap 'rm -f "$VALUES"' EXIT

# The daily copies are named by date, so the shell's sort order is the age order.
input() {
  if [ -z "$1" ]; then
    for f in "$OLD"/unit-mem.log-*.gz; do [ -f "$f" ] && gzip -dc "$f"; done
  fi
  cat "$LOG"
}

input "$1" | awk -v values="$VALUES" '
# Keeps one value per sample of a series (the memory held, the broker...) to
# find its p99 once all are in; sort puts the values of a series in order.
function series(name, what, v) {
  count[name "|" what]++
  print name "|" what, v | ("sort -k1,1 -k2,2n > " values)
}
function mib(b) { return sprintf("%.0f MiB", b / 1048576) }
{
  name = ""; delete f
  for (i = 2; i <= NF; i++) { split($i, kv, "="); f[kv[1]] = substr($i, length(kv[1]) + 2) }
  name = f["name"]; if (name == "") next
  if (name == "host") {
    if (f["mem_available"] != "" && (!hosts++ || f["mem_available"] + 0 < minavail)) minavail = f["mem_available"] + 0
    next
  }
  if (!(name in n)) order[++names] = name
  if (!n[name]++) first[name] = $1
  last[name] = $1
  held = f["anon"] + f["shmem"]
  if (held > max[name]) max[name] = held
  series(name, "held", held)
  if (f["node_max"] + 0 > nodemax[name]) nodemax[name] = f["node_max"] + 0
  if ("node_a" in f) split_[name] = 1
  if (f["node_a"] + 0 > nodea[name]) nodea[name] = f["node_a"] + 0
  if (f["node_b"] + 0 > nodeb[name]) nodeb[name] = f["node_b"] + 0
  if (f["node_other"] + 0 > nodeo[name]) nodeo[name] = f["node_other"] + 0
  if ("broker" in f) {
    sandbox_[name] = 1
    if (f["broker"] + 0 > brokermax[name]) brokermax[name] = f["broker"] + 0
    if (f["proxy"] + 0 > proxymax[name]) proxymax[name] = f["proxy"] + 0
    if (f["openresty"] + 0 > ormax[name]) ormax[name] = f["openresty"] + 0
    if (f["openresty_n"] + 0 > orn[name]) orn[name] = f["openresty_n"] + 0
    series(name, "broker", f["broker"] + 0)
    series(name, "proxy", f["proxy"] + 0)
    series(name, "openresty", f["openresty"] + 0)
  }
  if (f["git"] + 0 > gitmax[name]) gitmax[name] = f["git"] + 0
  if (f["git_n"] + 0 > gitn[name]) gitn[name] = f["git_n"] + 0
  if (f["oom_kill"] + 0 > oom[name]) oom[name] = f["oom_kill"] + 0
  if (f["peak"] + 0 > peakmem[name]) peakmem[name] = f["peak"] + 0
  if ("refault" in f) {
    squeeze_[name] = 1
    split("refault pressure_some pressure_full at_max", counters, " ")
    for (j in counters) {
      c = counters[j]; v = f[c] + 0; k = name SUBSEP c
      if (k in prev) rise[k] += (v >= prev[k]) ? v - prev[k] : v
      prev[k] = v
    }
  }
  limit[name] = f["limit"] + 0
  t = f["top"]; c = match(t, /:[0-9]+$/)
  if (c && t != "-:0" && substr(t, 1, c - 1) != "-") {
    comm = substr(t, 1, c - 1); b = substr(t, c + 1) + 0
    if (b > peak[name, comm]) peak[name, comm] = b
    seen[name, comm] = 1
  }
}
END {
  close("sort -k1,1 -k2,2n > " values)
  while ((getline line < values) > 0) {   # values come sorted by name, then size
    split(line, p, " "); seq[p[1]]++
    if (seq[p[1]] == int(0.99 * (count[p[1]] - 1)) + 1) p99[p[1]] = p[2]
  }
  for (k = 1; k <= names; k++) {
    name = order[k]
    printf "%s: %d samples, %s to %s\n", name, n[name], first[name], last[name]
    printf "  anon+shmem max %s, p99 %s; node_max max %s; oom_kill max %d\n", mib(max[name]), mib(p99[name "|held"]), mib(nodemax[name]), oom[name]
    if (split_[name]) printf "  node-a max %s, node-b max %s, other node max %s; git max %s in up to %d processes\n", mib(nodea[name]), mib(nodeb[name]), mib(nodeo[name]), mib(gitmax[name]), gitn[name]
    if (sandbox_[name]) printf "  broker max %s p99 %s, proxy jail max %s p99 %s, openresty max %s p99 %s in up to %d processes\n", mib(brokermax[name]), mib(p99[name "|broker"]), mib(proxymax[name]), mib(p99[name "|proxy"]), mib(ormax[name]), mib(p99[name "|openresty"]), orn[name]
    if (peakmem[name]) printf "  cgroup peak %s of limit %s\n", mib(peakmem[name]), mib(limit[name])
    if (squeeze_[name]) printf "  page cache: %s re-read (refaults), waited on memory %.1f s (some) %.1f s (full), at the limit %d times\n", mib(rise[name SUBSEP "refault"] * 4096), rise[name SUBSEP "pressure_some"] / 1e6, rise[name SUBSEP "pressure_full"] / 1e6, rise[name SUBSEP "at_max"]
    cmd = "sort -k1,1nr | head -5"; fflush()
    for (key in seen) { split(key, kp, SUBSEP); if (kp[1] == name) print peak[key], kp[2] | cmd }
    close(cmd)
  }
  if (hosts) printf "host: min mem_available %s\n", mib(minavail)
}' | awk '
  # top lines come out of sort as "bytes comm"; show them as "  top comm MiB"
  /^[0-9]+ / { printf "  top %s %.0f MiB\n", $2, $1 / 1048576; next } { print }'
