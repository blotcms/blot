#!/usr/bin/env bash
set -euo pipefail

# hide '^C' glyph while running ----
restore_tty() { :; }
if [ -t 1 ]; then
  STTY_ORIG="$(stty -g)"
  stty -echoctl
  restore_tty() { stty "$STTY_ORIG" 2>/dev/null || true; }
fi
# --------------------------------------------------

# Resolve repo paths
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../ && pwd)"
: "${BLOT_HOST:=local.blot}"

# Files
SETUP="$DIR/scripts/development/proxy/setup.sh"
COMPOSE_FILE="$DIR/scripts/development/docker-compose.yml"
AGENTATION="$DIR/scripts/development/agentation/run.sh"
FOLDER_SERVER="$DIR/scripts/development/open-folder-server.js"
TOXIPROXY_SETUP="$DIR/scripts/development/setup-toxiproxy.sh"
TOXIPROXY_ENABLE="$DIR/scripts/development/enable-toxiproxy-latency.sh"
TOXIPROXY_DISABLE="$DIR/scripts/development/disable-toxiproxy-latency.sh"

# Env for builds
export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-bake}"
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

# Compose wrapper
compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    BLOT_HOST="$BLOT_HOST" COMPOSE_BAKE=true docker-compose -f "$COMPOSE_FILE" "$@"
  else
    BLOT_HOST="$BLOT_HOST" COMPOSE_BAKE=true docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# Portable timeout helper
run_with_timeout() {
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"   # no timeout available; run as-is
  fi
}

FOLDER_PID=""
LOGS_PID=""
STACK_STARTED=0
AGENTATION_ATTEMPTED=0
SHUTTING_DOWN=0
cleanup() {
  (( SHUTTING_DOWN )) && return
  SHUTTING_DOWN=1

  if [ -n "$LOGS_PID" ]; then
    kill "$LOGS_PID" 2>/dev/null || true
    wait "$LOGS_PID" 2>/dev/null || true
  fi

  if [ "$STACK_STARTED" -eq 1 ]; then
    # bounded silent Redis SAVE before teardown
    if compose ps --services | grep -q '^redis$'; then
      run_with_timeout 5 compose exec -T redis redis-cli SAVE >/dev/null 2>&1 || true
    fi
    if [ "$AGENTATION_ATTEMPTED" -eq 1 ]; then
      echo "[start] Stopping Agentation"
      BLOT_HOST="$BLOT_HOST" bash "$AGENTATION" down || true
    fi
    # Also remove any remaining project orphans; named volumes are retained.
    compose down --remove-orphans --timeout 0 || true
  fi

  if [ -n "$FOLDER_PID" ] && kill -0 "$FOLDER_PID" 2>/dev/null; then
    kill "$FOLDER_PID" 2>/dev/null || true
    wait "$FOLDER_PID" 2>/dev/null || true
  fi
  restore_tty
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fail before TLS setup, background processes or Docker changes.
echo "[start] Checking Agentation MCP registration"
bash "$AGENTATION" check

echo "[start] Running setup"
bash "$SETUP" "$BLOT_HOST"

# Kill any existing process listening on port 3020
echo "[start] Checking for existing process on port 3020"
if lsof -ti:3020 >/dev/null 2>&1; then
  echo "[start] Killing existing process on port 3020"
  lsof -ti:3020 | xargs kill -9 2>/dev/null || true
fi

# Create .env if it doesn't exist
if [ ! -f "$DIR/.env" ]; then
  echo "[start] Creating .env file"
  touch "$DIR/.env"
fi

echo "[start] Launching local folder opener"
node "$FOLDER_SERVER" &
FOLDER_PID=$!

if [ "${BLOT_USE_TOXIPROXY:-true}" = "true" ]; then
  export BLOT_REDIS_HOST="${BLOT_REDIS_HOST:-toxiproxy}"
fi

STACK_STARTED=1
compose up --build -d

if [ "${BLOT_USE_TOXIPROXY:-true}" = "true" ]; then
  echo "[start] Configuring toxiproxy"
  bash "$TOXIPROXY_SETUP"
  # Keep startup fast until node-app reports capabilities.
  bash "$TOXIPROXY_DISABLE" >/dev/null 2>&1 || true
fi

echo "[start] Starting Agentation"
# Include partial setup in error cleanup.
AGENTATION_ATTEMPTED=1
BLOT_HOST="$BLOT_HOST" bash "$AGENTATION" up

# start logs in background to avoid 'exit status 130' noise on Ctrl-C
if [ "${BLOT_USE_TOXIPROXY:-true}" = "true" ]; then
  (
    FAST_MODE=1
    compose logs -f --no-log-prefix node-app | while IFS= read -r line; do
      echo "$line"

      if [[ "$line" == *"[nodemon] restarting due to changes"* ]]; then
        if [ "$FAST_MODE" -eq 0 ]; then
          FAST_MODE=1
          bash "$TOXIPROXY_DISABLE" || true
        fi
        continue
      fi

      if [[ "$line" == *"Local server capabilities"* ]]; then
        if [ "$FAST_MODE" -eq 1 ]; then
          FAST_MODE=0
          bash "$TOXIPROXY_ENABLE" || true
        fi
      fi
    done
  ) &
else
  compose logs -f --no-log-prefix node-app &
fi
LOGS_PID=$!

# Normal exit, errors and signals all run cleanup via the EXIT trap.
wait "$LOGS_PID" 2>/dev/null || true
exit 0
