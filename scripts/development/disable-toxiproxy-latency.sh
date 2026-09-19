#!/usr/bin/env bash
# Removes latency+jitter toxic from the redis proxy.
set -euo pipefail

API="http://127.0.0.1:8474"

curl -sf -X DELETE "${API}/proxies/redis/toxics/redis-latency" >/dev/null 2>&1 || true

echo "[toxiproxy] Latency disabled (startup/restart fast path)"

for stream in upstream downstream; do
  curl -sf -X DELETE "${API}/proxies/node/toxics/node-latency-${stream}" >/dev/null 2>&1 || true
done
