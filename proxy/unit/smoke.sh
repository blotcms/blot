#!/bin/bash
#
# Boots the unit image (Dockerfile target `unit`) as the blue unit with a peer
# that is not running, and checks that:
#   - OpenResty, node-a and node-b answer on their sockets, and a request
#     through the proxy reaches node-a
#   - the proxy was rendered in unit mode: this unit's sockets first, the
#     other unit's as backup
#   - killing node-a gets it started again while OpenResty keeps serving
#   - SIGTERM drains the unit and the container exits 0
#
#   proxy/unit/smoke.sh <image>
#
# Needs Redis on 127.0.0.1:6379, and the BLOT_STORAGE_* and BLOT_AWS_*
# variables .github/actions/start-minio exports. Run by
# .github/workflows/unit-image.yml. Uses the host network (it binds :80 and
# :443), so it is meant for a CI runner.
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image>}"
NAME="${UNIT_NAME:-blot-unit-smoke}"

fail() {
  echo "FAIL: $*" >&2
  docker logs --tail 200 "$NAME" >&2 || true
  exit 1
}

in_unit() { docker exec "$NAME" "$@"; }

# Succeeds if the socket answers /health. Node answers it for a loopback host.
healthy() {
  in_unit curl -fsS -o /dev/null --max-time 3 --unix-socket "$1" http://localhost/health
}

docker_healthy() {
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ]
}

# wait_for <description> <command...>: retries for up to three minutes
wait_for() {
  local description="$1"
  shift
  for _ in $(seq 1 180); do
    "$@" 2>/dev/null && { echo "ok: $description"; return 0; }
    sleep 1
  done
  fail "$description"
}

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" --network host \
  -e BLOT_UNIT=blue \
  -e BLOT_HOST=blot.im \
  -e BLOT_REDIS_HOST=127.0.0.1 \
  -e PROXY_FETCH_CDN_IPS=false \
  -e BLOT_STORAGE_BUCKET -e BLOT_STORAGE_ENDPOINT -e BLOT_STORAGE_REGION \
  -e BLOT_AWS_KEY -e BLOT_AWS_SECRET \
  "$IMAGE" >/dev/null

wait_for "the proxy's health socket answers" healthy /run/openresty/health.sock
wait_for "node-a answers /health" healthy /run/blot/blue-a.sock
wait_for "node-b answers /health" healthy /run/blot/blue-b.sock

wait_for "Docker reports the unit healthy" docker_healthy

# The dashboard's sign-in page is a GET, which the proxy sends to node-a
status=$(in_unit curl -ksS -o /dev/null -w '%{http_code}' -H 'Host: blot.im' \
  https://127.0.0.1/sites/log-in)
[ "$status" = 200 ] || fail "GET /sites/log-in through the proxy returned $status"
echo "ok: a request through the proxy reaches node-a"

# This unit's sockets are the primaries and the other unit's are the backups
conf=/usr/local/openresty/nginx/conf/nginx.conf
for server in \
  'unix:/run/blot/blue-b.sock weight=100' 'unix:/run/blot/green-b.sock backup' \
  'unix:/run/blot/blue-a.sock weight=100' 'unix:/run/blot/green-a.sock backup'; do
  in_unit grep -q "server $server" "$conf" || fail "nginx.conf has no 'server $server'"
done
echo "ok: the proxy was rendered in unit mode"

# node-a is the process started as `node app/index.js`; node-b is forked from it
node_a_pid() { in_unit pgrep -f '^node app/index.js$' | head -n 1 || true; }
openresty_pid() { in_unit cat /usr/local/openresty/nginx/logs/nginx.pid; }

before=$(node_a_pid)
master=$(openresty_pid)
[ -n "$before" ] || fail "could not find node-a"

in_unit kill -KILL "$before"

# OpenResty keeps answering while node-a is down and being restarted
for _ in $(seq 1 3); do
  healthy /run/openresty/health.sock || fail "the proxy stopped answering after node-a was killed"
  sleep 1
done

restarted() { [ -n "$(node_a_pid)" ] && [ "$(node_a_pid)" != "$before" ]; }
wait_for "node-a was started again" restarted
wait_for "the restarted node-a answers /health" healthy /run/blot/blue-a.sock
wait_for "node-b answers /health after node-a restarted" healthy /run/blot/blue-b.sock

[ "$(openresty_pid)" = "$master" ] || fail "OpenResty was restarted"
[ "$(docker inspect -f '{{.RestartCount}}' "$NAME")" = 0 ] || fail "the container restarted"
echo "ok: OpenResty kept running and the container did not restart"

# Draining on SIGTERM: both stop and the container exits 0
docker stop -t 40 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] || fail "the unit exited $code on SIGTERM"
echo "ok: SIGTERM drained the unit and it exited 0"

docker rm "$NAME" >/dev/null
