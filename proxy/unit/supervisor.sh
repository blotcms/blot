#!/bin/sh
#
# Runs one unit (blue or green, #2119): OpenResty and the Node app in one
# container. tini is PID 1 and starts this.
#
#   OpenResty  in the foreground, as the proxy image runs it. If it exits the
#              container exits, non-zero, so Docker restarts it; its listening
#              sockets (reuseport) go with it, and the other unit takes over.
#   node-a     `node app/index.js`, which forks node-b (helper/workerChild)
#              and supervises it. If node-a exits it is started again after a
#              delay that doubles from 1s to 30s and resets once it has run
#              for 60s. OpenResty is not touched.
#
# SIGTERM, SIGQUIT and SIGINT drain both, OpenResty first: `-s quit` lets it
# finish what it has accepted (up to worker_shutdown_timeout), which may still
# be waiting on node-a, and only once it has exited is node-a sent SIGTERM
# (helper/drain), which stops node-b first. Then this exits 0.
#
# Environment: BLOT_UNIT (blue or green) is required. Everything else defaults
# from it: the sockets in /run/blot (<unit>-a.sock for node-a, <unit>-b.sock for
# node-b) and the proxy's unit-mode upstreams, with the other unit's sockets as
# the backups (see "Runtime settings" in proxy/README.md).

OPENRESTY=/usr/local/openresty/bin/openresty
MIN_BACKOFF=1
MAX_BACKOFF=30
STABLE=60

case "${BLOT_UNIT:-}" in
  blue) peer=green ;;
  green) peer=blue ;;
  *) echo "supervisor: BLOT_UNIT must be blue or green" >&2; exit 1 ;;
esac

export BLOT_SOCKET="${BLOT_SOCKET:-/run/blot/$BLOT_UNIT-a.sock}"
export BLOT_WORKER_SOCKET="${BLOT_WORKER_SOCKET:-/run/blot/$BLOT_UNIT-b.sock}"
export PROXY_UNIT="${PROXY_UNIT:-$BLOT_UNIT}"
export PROXY_UPSTREAM_MODE="${PROXY_UPSTREAM_MODE:-unit}"
export PROXY_UNIT_MAIN="${PROXY_UNIT_MAIN:-unix:$BLOT_SOCKET}"
export PROXY_UNIT_WORKER="${PROXY_UNIT_WORKER:-unix:$BLOT_WORKER_SOCKET}"
export PROXY_PEER_MAIN="${PROXY_PEER_MAIN:-unix:/run/blot/$peer-a.sock}"
export PROXY_PEER_WORKER="${PROXY_PEER_WORKER:-unix:/run/blot/$peer-b.sock}"

# Waits for a child to exit and sets $status. A trapped signal cuts a wait
# short, so wait again until the child has really gone.
reap() {
  wait "$1"
  status=$?
  while kill -0 "$1" 2>/dev/null; do
    wait "$1"
    status=$?
  done
}

# Keeps node-a running. Runs in its own process so the backoff never delays
# watching OpenResty; SIGTERM ends it, and node-a with it.
run_node() {
  child=
  stopping=
  trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM

  backoff=$MIN_BACKOFF
  while [ -z "$stopping" ]; do
    started=$(date +%s)
    # OpenResty's master stays root; the app does not
    HOME=/home/node su-exec ec2-user:ec2-user node app/index.js &
    child=$!
    echo "supervisor: started node-a pid=$child"
    reap "$child"
    [ -n "$stopping" ] && break

    [ $(($(date +%s) - started)) -ge $STABLE ] && backoff=$MIN_BACKOFF
    echo "supervisor: node-a exited status=$status, restarting in ${backoff}s"
    sleep "$backoff" &
    child=$!
    reap "$child"
    backoff=$((backoff * 2))
    [ "$backoff" -gt $MAX_BACKOFF ] && backoff=$MAX_BACKOFF
  done
  exit 0
}

stopping=
stop() {
  stopping=1
  echo "supervisor: shutdown signal received, draining"
  "$OPENRESTY" -s quit || true
}
trap stop TERM QUIT INT

run_node &
node_loop=$!

# proxy-start (proxy/start.sh) prepares the container, then becomes OpenResty
/usr/local/bin/proxy-start "$OPENRESTY" -g "daemon off;" &
reap $!

# A signal cuts the wait short and stop has begun the drain; otherwise
# OpenResty died on its own
if [ -n "$stopping" ]; then
  exit_status=0
else
  exit_status=$status
  [ "$exit_status" -eq 0 ] && exit_status=1
  echo "supervisor: OpenResty exited status=$status, stopping the unit" >&2
fi

# OpenResty has exited, so nothing is left to send node-a a request
kill -TERM "$node_loop" 2>/dev/null
reap "$node_loop"
exit "$exit_status"
