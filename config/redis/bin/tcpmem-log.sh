#!/bin/sh
# Appends the kernel's TCP memory accounting and pressure/drop counters to
# ~/tcpmem.log, to date any recurrence of the TCP memory accounting leak
# (blotcms/blot#2041). mem and tcp_mem are in pages; Chrono is ms spent in
# memory pressure since boot. Installed in ec2-user's crontab, every 5 min.
LOG="$HOME/tcpmem.log"
mem=$(awk '/^TCP:/ {for (i = 1; i < NF; i++) if ($i == "mem") print $(i + 1)}' /proc/net/sockstat)
alloc=$(awk '/^TCP:/ {for (i = 1; i < NF; i++) if ($i == "alloc") print $(i + 1)}' /proc/net/sockstat)
limits=$(tr '\t' ',' < /proc/sys/net/ipv4/tcp_mem)
ext=$(awk '/^TcpExt:/ {if (!h) {split($0, k); h = 1} else {for (i = 2; i <= NF; i++) v[k[i]] = $i}}
  END {printf "pressures=%s chrono_ms=%s prune=%s rcvq_drop=%s ofo_drop=%s",
    v["TCPMemoryPressures"], v["TCPMemoryPressuresChrono"], v["PruneCalled"], v["TCPRcvQDrop"], v["TCPOFODrop"]}' /proc/net/netstat)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) mem=$mem tcp_mem=$limits sockets=$alloc $ext" >> "$LOG"
# Keep about a year of 5-minute samples.
if [ "$(wc -l < "$LOG")" -gt 110000 ]; then tail -n 100000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
