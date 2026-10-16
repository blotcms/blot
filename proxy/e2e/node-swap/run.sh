#!/usr/bin/env bash
# Rolling-redeploy e2e: does swapping the Node containers one by one drop
# requests? Run from the repo root on a Linux host with docker and sudo. Like
# production, the proxy reaches the Node containers over Unix sockets in a
# host directory (/run/blot there) owned by uid 1000, which is also the proxy's
# nginx worker user (ec2-user in the image); the sockets are 0666 anyway.
set -u
D=proxy/e2e/node-swap
SOCKET_DIR="${SOCKET_DIR:-${RUNNER_TEMP:-/tmp}/blot-run}"
export SOCKET_DIR
sudo install -d -o 1000 -g 1000 -m 0755 "$SOCKET_DIR"
PROXY_IMAGE="${PROXY_IMAGE:-blot-proxy:ns}"
export HOSTIP=$(hostname -I | awk '{print $1}')

bash $D/swap.sh start || exit 1
docker run -d --name ns-proxy --network host --cap-add SYS_NICE \
  --mount "type=bind,source=$SOCKET_DIR,target=/run/blot" \
  -e PROXY_UPSTREAM_BLUE=unix:/run/blot/blue.sock \
  -e PROXY_UPSTREAM_GREEN=unix:/run/blot/green.sock \
  -e PROXY_UPSTREAM_YELLOW=unix:/run/blot/yellow.sock \
  -e BLOT_HOST=localhost "$PROXY_IMAGE" >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' ns-proxy)" = healthy ] && break
  sleep 2
done

echo "== phase 1: baseline, no deploy =="
if ! DURATION=10 OUT=baseline.json node $D/load.js; then
  echo "BASELINE FAILED: the harness itself is broken (rate limits or routing), not the deploy"
  exit 1
fi

echo "== phase 2: load during rolling swap =="
DURATION=60 OUT=swap.json node $D/load.js &
load=$!
sleep 3
bash $D/swap.sh rolling; swap_rc=$?
wait $load; rc=$?
# A swap that stopped early still leaves the backups answering 2xx
if [ "$swap_rc" -ne 0 ]; then echo "FAIL: swap.sh exited $swap_rc"; rc=1; fi

echo "== proxy errors =="
docker logs ns-proxy 2>&1 | grep -E '\[(error|crit)\]|temporarily disabled|no live' | grep -v cacher | tail -80 || true
if docker logs ns-proxy 2>&1 | grep 'no live upstreams'; then
  echo "FAIL: requests found no live upstream during the swap"; rc=1
fi
for c in blue green yellow; do echo "== blot-container-$c =="; docker logs --tail 15 blot-container-$c 2>&1; done
exit $rc
