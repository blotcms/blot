#!/bin/sh
# Appends the kernel's TCP memory accounting and pressure/drop counters to
# ~/tcpmem.log, to date any recurrence of the TCP memory accounting leak
# (blotcms/blot#2041). mem and tcp_mem are in pages; Chrono is ms spent in
# memory pressure since boot. Run by /etc/cron.d/blot-redis as ec2-user,
# every 5 min.
#
# It also stores the sample in Redis at blot:redis-host:tcpmem, since only this
# host can read these counters. The app's scheduler alerts from it, and when it
# stops being updated (app/scheduler/check-redis-host.js). A replica or a
# write-frozen master refuses the write, so only the live master's sample is
# seen. The Redis value also carries the host's RAM and disk space in bytes
# (ram_total, ram_avail, disk_root and disk_backups as used/total/available), for the
# app's daily email; they are not in the log. BLOT_ROOT prefixes /proc, /etc,
# / and /backups, for the tests.
ROOT=${BLOT_ROOT:-}
LOG="$HOME/tcpmem.log"
mem=$(awk '/^TCP:/ {for (i = 1; i < NF; i++) if ($i == "mem") print $(i + 1)}' "$ROOT/proc/net/sockstat")
alloc=$(awk '/^TCP:/ {for (i = 1; i < NF; i++) if ($i == "alloc") print $(i + 1)}' "$ROOT/proc/net/sockstat")
limits=$(tr '\t' ',' < "$ROOT/proc/sys/net/ipv4/tcp_mem")
ext=$(awk '/^TcpExt:/ {if (!h) {split($0, k); h = 1} else {for (i = 2; i <= NF; i++) v[k[i]] = $i}}
  END {printf "pressures=%s chrono_ms=%s prune=%s rcvq_drop=%s ofo_drop=%s",
    v["TCPMemoryPressures"], v["TCPMemoryPressuresChrono"], v["PruneCalled"], v["TCPRcvQDrop"], v["TCPOFODrop"]}' "$ROOT/proc/net/netstat")
line="$(date -u +%Y-%m-%dT%H:%M:%SZ) mem=$mem tcp_mem=$limits sockets=$alloc $ext"
echo "$line" >> "$LOG"
# Keep about a year of 5-minute samples.
if [ "$(wc -l < "$LOG")" -gt 110000 ]; then tail -n 100000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi

# active=1 once cutover has marked this as the host clients use (the marker
# backup.sh checks): the app only expects maxmemory to be set from then on.
active=0
[ -s "$ROOT/etc/blot-redis/floating-ip" ] && active=1
# RAM and disk, for the daily email. A field that cannot be read is left out.
# df -k, because busybox df has that too. Available is kept apart from
# total - used, which counts blocks reserved for root. disk_backups only if /backups is a
# mount: the instance store is absent on a host without one, and df would then
# report the root disk.
extra=""
add() { [ -z "$2" ] || extra="$extra $1=$2"; }
disk() { df -P -k "$1" 2> /dev/null | awk 'NR == 2 {printf "%.0f/%.0f/%.0f", $3 * 1024, $2 * 1024, $4 * 1024}'; }
add ram_total "$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024}' "$ROOT/proc/meminfo" 2> /dev/null)"
add ram_avail "$(awk '/^MemAvailable:/ {printf "%.0f", $2 * 1024}' "$ROOT/proc/meminfo" 2> /dev/null)"
add disk_root "$(disk "$ROOT/")"
if mountpoint -q "$ROOT/backups" 2> /dev/null; then add disk_backups "$(disk "$ROOT/backups")"; fi

CLI=$(command -v redis6-cli || command -v valkey-cli || command -v redis-cli)
TIMEOUT=$(command -v timeout > /dev/null && echo "timeout 10")
# No TTL: the app spots a stopped sampler from the timestamp. Errors are
# dropped, since cron has nowhere to send them; a sample that stops arriving
# is itself the alert.
$TIMEOUT $CLI SET blot:redis-host:tcpmem "$line host=$(uname -n) active=$active$extra" > /dev/null 2>&1 || true
