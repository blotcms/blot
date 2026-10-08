#!/usr/bin/env bash
#
# Brings up everything proxy/deploy/blue-green.sh expects to find on the
# production host, using real Docker, so .github/workflows/proxy-deploy-e2e.yml
# can run the actual script unmodified. Assumes blot-proxy:e2e is already built
# (see the workflow) and that this shell's env already has E2E_ROOT set (the
# workflow exports it, along with the PROXY_* variables below, so later steps
# see the same values without re-sourcing this file).
#
# BLOT_HOST=blot.im. Every proxy container runs --network host and so shares
# the runner's loopback; PROXY_REDIS_HOST is the runner's own interface IP, as
# it is routable from every --network host container and from this shell.
set -euo pipefail

E2E_ROOT="${E2E_ROOT:?E2E_ROOT must be set}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTIP="$(hostname -I | awk '{print $1}')"

log() { printf '[setup] %s\n' "$*"; }

mkdir -p "$E2E_ROOT/cache" "$E2E_ROOT/logs" "$E2E_ROOT/blog-static" "$E2E_ROOT/global-static"

# ---- certificate -------------------------------------------------------
log "Generating a wildcard certificate for $BLOT_HOST and trusting its CA"
bash "$HERE/gen-certs.sh" "$BLOT_HOST" "$PROXY_CERT_DIR"

# ---- cache/log ownership -------------------------------------------------
# The image's worker runs as ec2-user (uid 1000, see proxy/Dockerfile), so the
# cache and log directories it mounts must be writable by that uid. Seed a
# couple of cache files so the rehydrate walk (proxy/config/cacher.lua
# build_index) has something to count, though an empty, writable directory
# rehydrates ("rehydrate: complete files=0") just as well. Seed BEFORE chowning
# to 1000: the runner user (not uid 1000) cannot write into the directory
# afterwards.
for f in warm-1 warm-2 warm-3; do
  echo "seeded by proxy/deploy/e2e" > "$PROXY_CACHE_DIR/$f"
done
sudo chown -R 1000:1000 "$PROXY_CACHE_DIR" "$PROXY_LOG_DIR"

# ---- proxy.env ------------------------------------------------------------
# PROXY_REDIS_HOST is $HOSTIP rather than 127.0.0.1; both are reachable from
# every --network host container and from this shell, so one value works
# everywhere.
cat > "$PROXY_ENV_FILE" <<EOF
BLOT_HOST=$BLOT_HOST
PROXY_REDIS_HOST=$HOSTIP
PROXY_PRIVATE_IP=127.0.0.1
EOF

# A second env file, identical except for PROXY_PRIVATE_IP, for the
# deterministic forced-failure scenarios in the workflow: 198.51.100.7 is
# TEST-NET-2 (RFC 5737), never assigned to a runner interface, so the real
# container's :8077 listener fails to bind and it never becomes healthy.
# validate_image() runs `openresty -t` with ip_nonlocal_bind, so preflight
# still passes with this file - only the real container fails to start, which
# is the point.
sed 's/^PROXY_PRIVATE_IP=.*/PROXY_PRIVATE_IP=198.51.100.7/' "$PROXY_ENV_FILE" > "$E2E_ROOT/proxy-unroutable-private-ip.env"

docker volume create "$PROXY_AUTOSSL_VOLUME" >/dev/null

# ---- redis ------------------------------------------------------------
# --protected-mode no: the image's default config otherwise refuses
# connections that arrive on a non-loopback address with no bind/requirepass
# configured, which is how the proxy containers and the check below reach it
# - over $HOSTIP, not loopback.
log "Starting Redis"
docker run -d --name blot-e2e-redis --network host redis:7-alpine \
  redis-server --protected-mode no >/dev/null
for i in $(seq 1 30); do
  timeout 2 bash -c "</dev/tcp/$HOSTIP/6379" 2>/dev/null && break
  sleep 1
  [ "$i" -lt 30 ] || { echo "redis never came up" >&2; docker logs blot-e2e-redis; exit 1; }
done

# ---- stub upstream (8088-8090, bound to every interface) -----------------
# STUB_BIND=0.0.0.0, as real production Node containers are (docker -p
# publishes to every interface by default).
log "Starting the stub upstream"
docker run -d --name blot-e2e-stub --network host -e STUB_BIND=0.0.0.0 \
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

log "Harness is up: Redis, stub upstream and $PROXY_NODE_CONTAINER running; no proxy container yet"
