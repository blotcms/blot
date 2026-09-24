#!/usr/bin/env bash
#
# Brings up everything proxy/deploy/cutover-from-baremetal.sh and
# proxy/deploy/blue-green.sh expect to find on the production host, using
# real Docker, so .github/workflows/proxy-deploy-e2e.yml can run the actual
# scripts unmodified. Assumes blot-proxy:e2e and blot-baremetal:e2e are
# already built (see the workflow) and that this shell's env already has
# E2E_ROOT set (the workflow exports it, along with the PROXY_* variables
# below, so later steps see the same values without re-sourcing this file).
#
#   BLOT_HOST=blot.im REDIS/upstream/etc all on 127.0.0.1 (--network host
#   everywhere, so containers share the runner's loopback - the simplest
#   stand-in for the private IP Node containers use in production; see
#   README.md).
set -euo pipefail

E2E_ROOT="${E2E_ROOT:?E2E_ROOT must be set}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[setup] %s\n' "$*"; }

mkdir -p "$E2E_ROOT/cache" "$E2E_ROOT/logs" "$E2E_ROOT/blog-static" "$E2E_ROOT/global-static"

# ---- certificate -------------------------------------------------------
log "Generating a wildcard certificate for $BLOT_HOST and trusting its CA"
bash "$HERE/gen-certs.sh" "$BLOT_HOST" "$PROXY_CERT_DIR"

# ---- cache/log ownership -------------------------------------------------
# The image's worker runs as ec2-user (uid 1000, see proxy/Dockerfile); the
# rehydrate probe (#1975) refuses to become healthy unless it can chown/write
# the cache root, and cutover's own rehydrate check needs to read it. Seed a
# couple of files so the walk (config/openresty/conf/cacher.lua build_index)
# has something to count, though an empty, writable directory rehydrates
# ("rehydrate: complete files=0") just as well.
sudo chown -R 1000:1000 "$PROXY_CACHE_DIR" "$PROXY_LOG_DIR"
for f in warm-1 warm-2 warm-3; do
  echo "seeded by proxy/deploy/e2e for the rehydrate probe" > "$PROXY_CACHE_DIR/$f"
done
sudo chown 1000:1000 "$PROXY_CACHE_DIR"/warm-*

# ---- proxy.env ------------------------------------------------------------
cat > "$PROXY_ENV_FILE" <<EOF
BLOT_HOST=$BLOT_HOST
PROXY_REDIS_HOST=127.0.0.1
PROXY_PRIVATE_IP=127.0.0.1
EOF

docker volume create "$PROXY_AUTOSSL_VOLUME" >/dev/null

# ---- redis ------------------------------------------------------------
log "Starting Redis"
docker run -d --name blot-e2e-redis --network host redis:7-alpine >/dev/null
for i in $(seq 1 30); do
  timeout 2 bash -c '</dev/tcp/127.0.0.1/6379' 2>/dev/null && break
  sleep 1
  [ "$i" -lt 30 ] || { echo "redis never came up" >&2; exit 1; }
done

# ---- stub upstream (127.0.0.1:8088-8090) ---------------------------------
log "Starting the stub upstream"
docker run -d --name blot-e2e-stub --network host \
  -v "$REPO_ROOT/proxy/e2e/stub-upstream.js":/s.js:ro \
  node:22-alpine node /s.js >/dev/null
for i in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8088/ && break
  sleep 1
  [ "$i" -lt 30 ] || { echo "stub upstream never came up" >&2; docker logs blot-e2e-stub; exit 1; }
done

# ---- fake Node container (purge probe target) ------------------------------
# purge_reachable() (proxy/deploy/common.sh) docker execs into
# $PROXY_NODE_CONTAINER and runs `node -e ...` against
# BLOT_REVERSE_PROXY_URLS, so this needs BLOT_REVERSE_PROXY_URLS in its own
# env and a `node` binary - node:22-alpine has both.
log "Starting the fake Node container ($PROXY_NODE_CONTAINER)"
docker run -d --name "$PROXY_NODE_CONTAINER" --network host \
  -e BLOT_REVERSE_PROXY_URLS="http://127.0.0.1:8077" \
  node:22-alpine sleep infinity >/dev/null

# ---- bare-metal OpenResty stand-in, managed by a real systemd unit -------
# The task's own systemctl-shim approach exists to route `systemctl <verb>
# openresty` (called through common.sh's sys(), i.e. `sudo -n systemctl ...`
# when not root) onto a container. GitHub-hosted ubuntu-latest runners are
# full VMs already running systemd with a real, already-on-PATH systemctl and
# passwordless sudo for the runner user, so a unit that wraps `docker
# start`/`docker stop` gets the same effect (start/stop/enable/disable/
# is-active/is-enabled all genuinely work, no state file, no PATH shimming
# needed - see README.md) with less to maintain than a hand-rolled shim.
log "Creating the bare-metal container and its systemd unit"
# --cap-add SYS_NICE: config/openresty/conf/initial.conf sets
# `worker_priority -20`, shared by both generators (see common.sh's
# run_args(), which grants the same capability to the real containers).
docker create --name blot-e2e-baremetal --network host --cap-add SYS_NICE \
  -v "$PROXY_CERT_DIR":/etc/ssl/private:ro \
  -v "$PROXY_CACHE_DIR":/var/cache/openresty \
  -v "$PROXY_LOG_DIR":/var/log/openresty \
  blot-baremetal:e2e >/dev/null

DOCKER_BIN="$(command -v docker)"
sudo tee /etc/systemd/system/openresty.service >/dev/null <<EOF
[Unit]
Description=proxy-deploy-e2e stand-in for bare-metal OpenResty (blot-e2e-baremetal container)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$DOCKER_BIN start blot-e2e-baremetal
ExecStop=$DOCKER_BIN stop --time 10 blot-e2e-baremetal
TimeoutStartSec=90
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now openresty

log "Waiting for bare-metal OpenResty to serve $BLOT_HOST"
for i in $(seq 1 60); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    --connect-to "$BLOT_HOST:443:127.0.0.1:443" "https://$BLOT_HOST/" 2>/dev/null || echo 000)
  [ "$code" = 200 ] && break
  sleep 1
  [ "$i" -lt 60 ] || { echo "bare-metal OpenResty never answered 200 (last: $code)" >&2; docker logs blot-e2e-baremetal; exit 1; }
done

log "Harness is up: bare-metal serving $BLOT_HOST, Redis, stub upstream and $PROXY_NODE_CONTAINER running"
