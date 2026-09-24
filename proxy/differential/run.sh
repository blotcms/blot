#!/usr/bin/env bash
#
# Runs the request corpus (corpus.js) against the bare-metal OpenResty config
# and the proxy container's config in turn, against the same stub upstream
# and Redis, and diffs the results (diff.js). See corpus.js and diff.js for
# what this does and doesn't cover.
#
# Expects both images to already be built (see
# .github/workflows/proxy-differential.yml):
#   blot-proxy:differential            proxy/Dockerfile
#   blot-proxy:baremetal-differential  proxy/differential/baremetal.Dockerfile
#
# Both configs listen on :80/:443 (BLOT_HOST=blot.im for both - see
# corpus.js), so the two phases below run one at a time, on the runner's own
# network (--network host), against the SAME stub upstream and Redis:
# the config differences under test are in the generated nginx config, not in
# what's behind it. This also sidesteps the container config's SO_REUSEPORT
# (the bare-metal config doesn't have it, so the two could not share :80/:443
# concurrently even if that were otherwise useful here).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cleanup() {
  docker rm -f stub redis proxy baremetal >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup # in case a previous run left containers behind

echo "--- starting redis + stub upstream ---"
docker run -d --name redis --network host redis:6.2.12-alpine
docker run -d --name stub --network host \
  -v "$SCRIPT_DIR/../e2e/stub-upstream.js:/s.js" node:22-alpine node /s.js

for i in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8088/ && break
  sleep 1
done

# Waits for a config's readiness endpoint, then runs the corpus against it.
# `host.blot.im` matches the wildcard blog vhost (config/openresty/conf/
# server.conf) on plain :80, so this doesn't depend on the stub, Redis or TLS
# being up - only that OpenResty itself parsed the config and is listening.
wait_ready() {
  local container="$1"
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: readiness.blot.im' http://127.0.0.1/health || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "$container did not become ready" >&2
  docker logs "$container" || true
  return 1
}

echo "--- container config ---"
docker run -d --name proxy --network host --cap-add SYS_NICE \
  -e BLOT_HOST=blot.im -e PROXY_REDIS_HOST=127.0.0.1 -e PROXY_FETCH_CDN_IPS=false \
  blot-proxy:differential
wait_ready proxy
node capture.js container container-capture.json
docker logs proxy > container.log 2>&1 || true
docker rm -f proxy >/dev/null

echo "--- bare-metal config ---"
docker run -d --name baremetal --network host --cap-add SYS_NICE \
  blot-proxy:baremetal-differential
wait_ready baremetal
node capture.js baremetal baremetal-capture.json
docker logs baremetal > baremetal.log 2>&1 || true
docker rm -f baremetal >/dev/null

echo "--- diff ---"
node diff.js container-capture.json baremetal-capture.json
