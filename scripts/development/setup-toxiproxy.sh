#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"

# Measured against prod Redis (172.30.0.138) via `redis-cli --latency` /
# `--latency-history` over SSH: min 0ms, max 1ms, avg ~0.15-0.27ms, very
# stable across samples (near-zero jitter) - it's same-VPC/same-AZ traffic.
# 3ms/3ms below is already a couple ms of margin above that observed worst
# case, not a literal replay of it.
LATENCY_MS="${BLOT_TOXIPROXY_LATENCY_MS:-3}"
JITTER_MS="${BLOT_TOXIPROXY_JITTER_MS:-3}"
LOSS_PERCENT="${BLOT_TOXIPROXY_PACKET_LOSS_PERCENT:-2}"
REORDER_PERCENT="${BLOT_TOXIPROXY_REORDER_PERCENT:-10}"

API="http://127.0.0.1:8474"
compose() {
  BLOT_HOST="${BLOT_HOST:-local.blot}" \
  command -v docker-compose >/dev/null 2>&1 \
    && docker-compose -f "$COMPOSE_FILE" "$@" \
    || docker compose -f "$COMPOSE_FILE" "$@"
}

if [ "${BLOT_USE_TOXIPROXY:-true}" != "true" ]; then
  echo "[toxiproxy] BLOT_USE_TOXIPROXY is not true, skipping setup"
  exit 0
fi

DEBUG="${BLOT_TOXIPROXY_DEBUG:-}"

# Toxiproxy image is FROM scratch (no shell/wget/curl), so check from host via published port.
# Use short timeouts so curl cannot hang.
echo "[toxiproxy] Waiting for toxiproxy API (http://127.0.0.1:8474/version)"
for i in $(seq 1 25); do
  [ -n "$DEBUG" ] && echo "[toxiproxy] attempt $i/25 ..."
  if out=$(curl -sf --connect-timeout 2 --max-time 3 http://127.0.0.1:8474/version 2>&1); then
    [ -n "$DEBUG" ] && echo "[toxiproxy] attempt $i/25: got response"
    break
  fi
  curl_exit=$?
  [ -n "$DEBUG" ] && echo "[toxiproxy] attempt $i/25: curl exit=$curl_exit"
  sleep 0.5
done

if ! last_out=$(curl -sf --connect-timeout 2 --max-time 3 http://127.0.0.1:8474/version 2>&1); then
  echo "[toxiproxy] API not reachable after 25 attempts (port 8474 published? container running?)"
  echo "[toxiproxy] Try: BLOT_TOXIPROXY_DEBUG=1 ./scripts/development/start.sh (shows each attempt), or: docker compose -f $COMPOSE_FILE ps && docker compose -f $COMPOSE_FILE logs toxiproxy"
  exit 1
fi
[ -n "$DEBUG" ] && echo "[toxiproxy] API ready: $last_out"

# Toxiproxy image is FROM scratch (no shell), so use HTTP API from host instead of exec.
# Create proxy only; start.sh toggles latency based on server logs (fast startup/restarts).
echo "[toxiproxy] Configuring redis proxy via API (latency toggled after server readiness logs) ..."
curl -sf -X DELETE "${API}/proxies/redis" >/dev/null 2>&1 || true
curl -sf -X POST "${API}/proxies" -H "Content-Type: application/json" -d "{\"name\":\"redis\",\"listen\":\"0.0.0.0:6379\",\"upstream\":\"redis:6379\"}" >/dev/null

echo "[toxiproxy] Ready: node-app -> toxiproxy:6379 -> redis:6379 (latency ${LATENCY_MS}ms + jitter ${JITTER_MS}ms once server is ready)"
echo "[toxiproxy] Note: packet loss/reorder (tc netem) skipped — image has no shell; set BLOT_USE_TOXIPROXY=false or ignore."
