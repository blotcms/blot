#!/usr/bin/env bash
# Adds latency+jitter toxic to the redis proxy.
set -euo pipefail

LATENCY_MS="${BLOT_TOXIPROXY_LATENCY_MS:-6}"
JITTER_MS="${BLOT_TOXIPROXY_JITTER_MS:-10}"
API="http://127.0.0.1:8474"

curl -sf -X POST "${API}/proxies/redis/toxics" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"redis-latency\",\"type\":\"latency\",\"attributes\":{\"latency\":${LATENCY_MS},\"jitter\":${JITTER_MS}}}" \
  >/dev/null

echo "[toxiproxy] Latency now active: ${LATENCY_MS}ms + jitter ${JITTER_MS}ms (enabled after server readiness)"

# nginx -> node-app. Measured from a client against blot.im: ~190ms round trip
# (connect time; TTFB minus TLS is one RTT for cached pages, ~+90ms when Node
# renders). Multiplied by 1.5 = ~285ms per request, split across both
# directions, with ~30ms jitter. Applied per direction, so a request pays 2x.
NODE_LATENCY_MS="${BLOT_TOXIPROXY_NODE_LATENCY_MS:-143}"
NODE_JITTER_MS="${BLOT_TOXIPROXY_NODE_JITTER_MS:-30}"

for stream in upstream downstream; do
  curl -sf -X DELETE "${API}/proxies/node/toxics/node-latency-${stream}" >/dev/null 2>&1 || true
  curl -sf -X POST "${API}/proxies/node/toxics" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"node-latency-${stream}\",\"type\":\"latency\",\"stream\":\"${stream}\",\"attributes\":{\"latency\":${NODE_LATENCY_MS},\"jitter\":${NODE_JITTER_MS}}}" \
    >/dev/null
done

echo "[toxiproxy] Node latency active: ${NODE_LATENCY_MS}ms each way + jitter ${NODE_JITTER_MS}ms"
