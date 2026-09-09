#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(dirname "$0")
ROOT_DIR=$(realpath "$SCRIPT_DIR/../..")

# Parse --output <path> so we can mount the host dir and pass container path
BENCH_ARGS=()
OUTPUT_MOUNT=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" && -n "${2:-}" ]]; then
    OUT_PATH="$2"
    shift 2
    if [[ "$OUT_PATH" == /* ]]; then
      HOST_OUTPUT_DIR=$(dirname "$OUT_PATH")
    else
      HOST_OUTPUT_DIR="$ROOT_DIR/$(dirname "$OUT_PATH")"
    fi
    mkdir -p "$HOST_OUTPUT_DIR"
    HOST_OUTPUT_DIR=$(realpath "$HOST_OUTPUT_DIR")
    OUTPUT_MOUNT=(-v "$HOST_OUTPUT_DIR:/benchmarks")
    BENCH_ARGS+=(--output "/benchmarks/$(basename "$OUT_PATH")")
  else
    BENCH_ARGS+=("$1")
    shift
  fi
done

if ((${#BENCH_ARGS[@]} > 0)); then
  echo "Running benchmarks with args: ${BENCH_ARGS[*]}"
else
  echo "Running benchmarks with no args"
fi

BLOT_BENCH_ID="${BLOT_BENCH_ID:-blot-bench-$$-${RANDOM}}"
REDIS_CONTAINER="benchmark-redis-${BLOT_BENCH_ID}"
BENCH_CONTAINER="benchmark-runner-${BLOT_BENCH_ID}"
BENCH_NETWORK="benchmark-net-${BLOT_BENCH_ID}"

REDIS_IMAGE="redis:alpine"
BENCH_IMAGE="blot-bench"

APP_DIR=$(realpath "$SCRIPT_DIR/../../app")
SCRIPTS_DIR=$(realpath "$SCRIPT_DIR/../../scripts")
CONFIG_DIR=$(realpath "$SCRIPT_DIR/../../config")

BENCH_ENV=(
  -e BLOT_REDIS_HOST="$REDIS_CONTAINER"
  -e BLOT_HOST="localhost"
  -e BLOT_PROTOCOL="https"
  -e NODE_PATH="app"
)

cleanup() {
  docker rm -f "$BENCH_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$BENCH_NETWORK" >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker rm -f "$REDIS_CONTAINER" "$BENCH_CONTAINER" >/dev/null 2>&1 || true
docker network rm "$BENCH_NETWORK" >/dev/null 2>&1 || true

docker network create "$BENCH_NETWORK" >/dev/null

docker run -d \
  --name "$REDIS_CONTAINER" \
  --network "$BENCH_NETWORK" \
  --rm \
  "$REDIS_IMAGE" \
  sh -c "rm -f /data/dump.rdb && redis-server" >/dev/null

docker build \
  --target dev \
  -t "$BENCH_IMAGE" \
  "$ROOT_DIR" >/dev/null

# With set -u, expanding empty OUTPUT_MOUNT or BENCH_ARGS is an error; allow unset for this line
set +u
docker run --rm \
  --name "$BENCH_CONTAINER" \
  --network "$BENCH_NETWORK" \
  "${BENCH_ENV[@]}" \
  -e DEBUG="${DEBUG:-}" \
  -v "$APP_DIR:/usr/src/app/app" \
  -v "$SCRIPTS_DIR:/usr/src/app/scripts" \
  -v "$CONFIG_DIR:/usr/src/app/config" \
  "${OUTPUT_MOUNT[@]}" \
  "$BENCH_IMAGE" \
  sh -lc 'rm -rf /usr/src/app/data && mkdir /usr/src/app/data && node -v && npm -v && node scripts/benchmarks "$@"' sh "${BENCH_ARGS[@]}"
set -u
