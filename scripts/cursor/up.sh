#!/usr/bin/env bash
# Bring up the Blot application stack (idempotent). Redis is accessed directly
# (toxiproxy is disabled), so the running stack is node-app + redis + nginx.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/../.." && pwd)"
cd "$REPO_DIR"

COMPOSE_FILE="scripts/development/docker-compose.yml"

# Make sure the Docker daemon is available (no-op if start.sh already ran it).
bash "$DIR/start-docker.sh"

export BLOT_HOST=local.blot
export BLOT_REDIS_HOST=redis      # talk to Redis directly
export BLOT_USE_TOXIPROXY=false   # skip toxiproxy latency simulation

touch "$REPO_DIR/.env"

COMPOSE_BAKE=true docker compose -f "$COMPOSE_FILE" up -d

# toxiproxy only starts to satisfy the compose dependency graph; it is unused,
# so stop it to genuinely disable it.
docker compose -f "$COMPOSE_FILE" stop toxiproxy >/dev/null 2>&1 || true
