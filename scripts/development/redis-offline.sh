#!/usr/bin/env bash
# Simulates Redis being unreachable in development by toggling the toxiproxy
# "redis" proxy that the node app connects through (see setup-toxiproxy.sh).
#
#   redis-offline.sh down     refuse connections and drop existing ones
#                             (like a stopped Redis: "connection refused")
#   redis-offline.sh hang     accept connections but never reply
#                             (like a network partition: timeouts)
#   redis-offline.sh up       restore normal service
#   redis-offline.sh status
#
# Requires the dev stack to be running with BLOT_USE_TOXIPROXY=true (default).
set -euo pipefail

API="http://127.0.0.1:8474"
TOXIC="redis-offline-hang"

api() {
  curl -sf --connect-timeout 2 --max-time 5 "$@"
}

if ! api "${API}/proxies/redis" >/dev/null; then
  echo "[redis-offline] toxiproxy redis proxy not reachable at ${API}. Is the dev stack running with toxiproxy enabled?" >&2
  exit 1
fi

restore() {
  api -X DELETE "${API}/proxies/redis/toxics/${TOXIC}" >/dev/null 2>&1 || true
  api -X POST "${API}/proxies/redis" -H "Content-Type: application/json" \
    -d '{"enabled":true}' >/dev/null
}

case "${1:-}" in
  down)
    restore
    api -X POST "${API}/proxies/redis" -H "Content-Type: application/json" \
      -d '{"enabled":false}' >/dev/null
    echo "[redis-offline] Redis is DOWN (connections refused). Restore with: $0 up"
    ;;
  hang)
    restore
    # A timeout toxic with timeout=0 swallows data and never closes the connection
    api -X POST "${API}/proxies/redis/toxics" -H "Content-Type: application/json" \
      -d "{\"name\":\"${TOXIC}\",\"type\":\"timeout\",\"stream\":\"downstream\",\"attributes\":{\"timeout\":0}}" >/dev/null
    echo "[redis-offline] Redis is HANGING (connections open, no replies). Restore with: $0 up"
    ;;
  up)
    restore
    echo "[redis-offline] Redis is UP"
    ;;
  status)
    api "${API}/proxies/redis" | grep -o '"enabled":[a-z]*' | sed 's/^/[redis-offline] proxy /'
    api "${API}/proxies/redis/toxics" | grep -q "${TOXIC}" \
      && echo "[redis-offline] hang toxic active" || echo "[redis-offline] no hang toxic"
    ;;
  *)
    echo "usage: $0 {down|hang|up|status}" >&2
    exit 2
    ;;
esac
