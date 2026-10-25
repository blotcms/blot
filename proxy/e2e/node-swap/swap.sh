#!/usr/bin/env bash
# Usage: swap.sh start | rolling
# `rolling` mirrors deployContainer() in scripts/deploy/index.js: for blue, then
# green, then yellow, sequentially: docker stop, rm -f, create, start, wait for
# docker health, then curl /health on the published port and on the Unix socket
# the proxy uses. Flags follow util/generateDockerCommand.js. Needs SOCKET_DIR
# (host dir owned by uid 1000, mounted at /run/blot as in production).
set -eu
: "${SOCKET_DIR:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
PORTS="blue:8088 green:8089 yellow:8090"

create() { # <colour> <port>
  docker create --name "blot-container-$1" --restart unless-stopped --stop-timeout 30 \
    --user 1000:1000 --mount "type=bind,source=$SOCKET_DIR,target=/run/blot" \
    -p "$2:8080" -e "NAME=$1" -e "BLOT_SOCKET=/run/blot/$1.sock" -e NODE_PATH=/fake:/app \
    -v "$DIR/app.js:/app.js:ro" -v "$DIR/fake:/fake:ro" \
    -v "$ROOT/app/helper/drain.js:/app/helper/drain.js:ro" \
    -v "$ROOT/app/helper/listen.js:/app/helper/listen.js:ro" \
    --health-cmd 'wget -qO- http://127.0.0.1:8080/health' \
    --health-interval 2s --health-start-period 60s \
    node:24.22.1-alpine node /app.js >/dev/null
}

wait_healthy() { # <colour>
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "blot-container-$1")" = healthy ] && return 0
    sleep 1
  done
  docker logs "blot-container-$1"; return 1
}

each() { for cp in $PORTS; do "$1" "${cp%%:*}" "${cp##*:}"; done; }

start() { create "$1" "$2"; docker start "blot-container-$1" >/dev/null; }

swap() {
  echo "swapping $1"
  docker stop --time 30 "blot-container-$1" >/dev/null
  docker rm -f "blot-container-$1" >/dev/null
  start "$1" "$2"
  wait_healthy "$1"
  for _ in 1 2 3; do curl -sf "http://127.0.0.1:$2/health" >/dev/null; done
  curl -sf --unix-socket "$SOCKET_DIR/$1.sock" http://localhost/health >/dev/null
}

case "${1:-}" in
  start) each start; for cp in $PORTS; do wait_healthy "${cp%%:*}"; done ;;
  rolling) each swap ;;
  *) echo "usage: $0 start|rolling" >&2; exit 2 ;;
esac
