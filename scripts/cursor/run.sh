#!/usr/bin/env bash
# Long-running foreground process for the "blot" terminal: make sure the stack
# is up, then stream the application logs. The stack itself is brought up by the
# environment "start" phase; this keeps the lifecycle and logs visible.
#   - Dashboard / docs:  https://local.blot
#   - A blog:            https://<handle>.local.blot
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/../.." && pwd)"
cd "$REPO_DIR"

COMPOSE_FILE="scripts/development/docker-compose.yml"

# Ensure the stack is running (idempotent) in case this terminal starts on its
# own, then follow the logs.
bash "$DIR/up.sh"

echo "[run] Blot is up at https://local.blot — streaming logs (Ctrl-C detaches; containers keep running)."
exec docker compose -f "$COMPOSE_FILE" logs -f --no-log-prefix node-app nginx redis
