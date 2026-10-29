#!/bin/bash
# The unit stand-in's PID 1: the stub for node-a and node-b, and OpenResty
# started as proxy/unit/supervisor.sh does, in unit mode, draining on SIGTERM.
case "${BLOT_UNIT:-}" in
  blue) peer=green ;;
  green) peer=blue ;;
  *) echo "BLOT_UNIT must be blue or green" >&2; exit 1 ;;
esac
export BLOT_SOCKET="${BLOT_SOCKET:-/run/blot/$BLOT_UNIT-a.sock}"
export BLOT_WORKER_SOCKET="${BLOT_WORKER_SOCKET:-/run/blot/$BLOT_UNIT-b.sock}"
export PROXY_UPSTREAM_MODE=unit
export PROXY_UNIT_MAIN="unix:$BLOT_SOCKET" PROXY_UNIT_WORKER="unix:$BLOT_WORKER_SOCKET"
export PROXY_PEER_MAIN="unix:/run/blot/$peer-a.sock" PROXY_PEER_WORKER="unix:/run/blot/$peer-b.sock"

node /usr/src/app/stub-node.js &
node_pid=$!

OPENRESTY=/usr/local/openresty/bin/openresty
stop() { "$OPENRESTY" -s quit || true; kill "$node_pid" 2>/dev/null; }
trap stop TERM QUIT INT

/usr/local/bin/proxy-start "$OPENRESTY" -g "daemon off;" &
pid=$!
wait "$pid"
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; done
