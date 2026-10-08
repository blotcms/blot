#!/bin/sh
# Appends the kernel's TCP memory accounting and pressure/drop counters to
# ~/tcpmem.log, to date any recurrence of the TCP memory accounting leak
# (blotcms/blot#2041). mem and tcp_mem are in pages; Chrono is ms spent in
# memory pressure since boot. Installed in ec2-user's crontab, every 5 min.
#
# It also stores the sample in Redis at blot:redis-host:tcpmem, since only this
# host can read these counters. The app's scheduler alerts from it, and when it
# stops being updated (app/scheduler/check-redis-host.js). A replica or a
# write-frozen master refuses the write, so only the live master's sample is
# seen. BLOT_ROOT prefixes /proc and /etc, for the tests.
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
CLI=$(command -v redis6-cli || command -v valkey-cli || command -v redis-cli)
TIMEOUT=$(command -v timeout > /dev/null && echo "timeout 10")
# No TTL: the app spots a stopped sampler from the timestamp. Errors are
# dropped, since cron has nowhere to send them; a sample that stops arriving
# is itself the alert.
$TIMEOUT $CLI SET blot:redis-host:tcpmem "$line host=$(uname -n) active=$active" > /dev/null 2>&1 || true
