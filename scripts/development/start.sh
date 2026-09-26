#!/usr/bin/env bash
set -euo pipefail

# hide '^C' glyph while running ----
if [ -t 1 ]; then
  STTY_ORIG="$(stty -g)"
  stty -echoctl
  restore_tty() { stty "$STTY_ORIG" 2>/dev/null || true; }
  trap restore_tty EXIT
fi
# --------------------------------------------------

# Resolve repo paths
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../ && pwd)"
: "${BLOT_HOST:=local.blot}"

# Files
SETUP="$DIR/config/openresty/setup.sh"
COMPOSE_FILE="$DIR/scripts/development/docker-compose.yml"
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

compose up --build -d

if [ "${BLOT_USE_TOXIPROXY:-true}" = "true" ]; then
  echo "[start] Configuring toxiproxy"
  bash "$TOXIPROXY_SETUP"
  # Keep startup fast until node-app reports capabilities.
  bash "$TOXIPROXY_DISABLE" >/dev/null 2>&1 || true
fi

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

SHUTTING_DOWN=0
cleanup() {
  (( SHUTTING_DOWN )) && return
  SHUTTING_DOWN=1

  # stop log follower quietly first
  kill "$LOGS_PID" 2>/dev/null || true
  wait "$LOGS_PID" 2>/dev/null || true

  # bounded silent Redis SAVE before teardown
  if compose ps --services | grep -q '^redis$'; then
    run_with_timeout 5 compose exec -T redis redis-cli SAVE >/dev/null 2>&1 || true
  fi

  # hard, immediate shutdown
  compose down --remove-orphans --timeout 0 || true

  # stop aux server
  if kill -0 "$FOLDER_PID" 2>/dev/null; then
    kill "$FOLDER_PID" 2>/dev/null || true
    wait "$FOLDER_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

# wait on logs; normal exit handled by trap
wait "$LOGS_PID" 2>/dev/null || true

cleanup
exit 0
