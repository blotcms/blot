#!/bin/sh
# Summarises unit-mem.log (written by unit-mem-log.sh): for each container the
# sample count, first and last sample, max and p99 of anon+shmem (the memory
# that can't be reclaimed), max node_max, max oom_kill and the five
# non-node processes with the highest peak RSS; and the host's lowest
# mem_available. Read-only. Usage: unit-mem-summary.sh [logfile]
LOG="${1:-/var/instance-ssd/logs/unit-mem.log}"
VALUES=$(mktemp) || exit 1
trap 'rm -f "$VALUES"' EXIT

awk -v values="$VALUES" '
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
  print name, held | ("sort -k1,1 -k2,2n > " values)
  if (f["node_max"] + 0 > nodemax[name]) nodemax[name] = f["node_max"] + 0
  if (f["oom_kill"] + 0 > oom[name]) oom[name] = f["oom_kill"] + 0
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
    if (seq[p[1]] == int(0.99 * (n[p[1]] - 1)) + 1) p99[p[1]] = p[2]
  }
  for (k = 1; k <= names; k++) {
    name = order[k]
    printf "%s: %d samples, %s to %s\n", name, n[name], first[name], last[name]
    printf "  anon+shmem max %s, p99 %s; node_max max %s; oom_kill max %d\n", mib(max[name]), mib(p99[name]), mib(nodemax[name]), oom[name]
    cmd = "sort -k1,1nr | head -5"; fflush()
    for (key in seen) { split(key, kp, SUBSEP); if (kp[1] == name) print peak[key], kp[2] | cmd }
    close(cmd)
  }
  if (hosts) printf "host: min mem_available %s\n", mib(minavail)
}' "$LOG" | awk '
  # top lines come out of sort as "bytes comm"; show them as "  top comm MiB"
  /^[0-9]+ / { printf "  top %s %.0f MiB\n", $2, $1 / 1048576; next } { print }'
