#!/usr/bin/env bash
set -euo pipefail

# Counts the Redis commands one dashboard request sends, per path, on a preview
# slot (or the main stack with SLOT=main). VERBOSE=1 also lists them by name.
#
#   scripts/development/dashboard-qa/redis-per-request.sh /sites /sites/local

SLOT=${SLOT:-a}
if [ "$SLOT" = main ]; then HOST=local.blot; CONTAINER=blot-node-app-1; else HOST=$SLOT-local.blot; CONTAINER=blot-node-$SLOT; fi
UA="Mozilla/5.0 (Macintosh) Chrome/130 Safari/537"
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$CONTAINER" | awk '{print $1}')
JAR=$(mktemp)
MONITOR=$(mktemp)
trap 'rm -f "$JAR" "$MONITOR"' EXIT

LOGIN=$(docker exec "$CONTAINER" node scripts/blog/access.js example@example.com 2>/dev/null | grep -m1 '^https://' | sed "s#https://[^/]*#https://$HOST#")
curl -sk -A "$UA" -c "$JAR" -b "$JAR" -o /dev/null -L "$LOGIN&redirected=true"

for path in "$@"; do
  # Warm caches first, then count a second request
  curl -sk -A "$UA" -b "$JAR" -o /dev/null "https://$HOST$path"
  docker exec blot-redis-1 sh -c 'timeout 3 redis-cli MONITOR' > "$MONITOR" 2>/dev/null &
  sleep 0.5
  curl -sk -A "$UA" -b "$JAR" -o /dev/null "https://$HOST$path"
  wait
  grep "$IP:" "$MONITOR" | grep -v '"PING"\|"ping"' > "$MONITOR.f" || true
  echo "$(wc -l < "$MONITOR.f" | tr -d ' ') $path"
  if [ -n "${VERBOSE:-}" ]; then awk '{print $4}' "$MONITOR.f" | tr -d '"' | sort | uniq -c | sort -rn | head -12; fi
  rm -f "$MONITOR.f"
done
