#!/bin/sh
# Appends Redis memory usage to ~/redis-mem.log, to size maxmemory and spot
# growth before it reaches the limit (blotcms/blot#2041). Byte counts are
# exact; peak is Redis's high-water mark since it last started, so read it
# with the start date in mind. Installed in ec2-user's crontab, every 5 min.
LOG="$HOME/redis-mem.log"
CLI=$(command -v redis6-cli || command -v valkey-cli || command -v redis-cli)
info=$($CLI INFO 2>&1 | tr -d '\r')
field() { echo "$info" | awk -F: -v k="$1" '$1 == k {print $2}'; }
keys=$(echo "$info" | awk -F'[:=,]' '/^db0:/ {print $3}')
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) used=$(field used_memory) rss=$(field used_memory_rss)" \
  "peak=$(field used_memory_peak) frag=$(field mem_fragmentation_ratio) maxmemory=$(field maxmemory)" \
  "keys=${keys:-?} clients=$(field connected_clients) cow=$(field rdb_last_cow_size)" \
  "bgsave_sec=$(field rdb_last_bgsave_time_sec) loading=$(field loading) role=$(field role)" >> "$LOG"
# Keep about a year of 5-minute samples.
if [ "$(wc -l < "$LOG")" -gt 110000 ]; then tail -n 100000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
