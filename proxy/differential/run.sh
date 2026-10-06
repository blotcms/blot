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
  # `[ -n "$STATIC_DIR" ] && rm -rf ...` would make this function - and, under
  # set -e, the whole script - exit non-zero on the FIRST cleanup call below
  # (before STATIC_DIR is set), silently, since nothing has echoed yet. Use
  # if/fi, which returns 0 when the condition is false, instead of `&&`.
  if [ -n "${STATIC_DIR:-}" ]; then
    rm -rf "$STATIC_DIR"
  fi
}
trap cleanup EXIT

echo "=== proxy/differential/run.sh starting ==="

echo "--- cleanup (in case a previous run left containers behind) ---"
cleanup

echo "--- writing the cdn. fixture ---"
STATIC_DIR="$(mktemp -d)"

# Two fixtures for the cdn. corpus cases (corpus.js), mounted read-only into
# both containers at the same two paths both generators default to
# (build-baremetal-config.sh's BLOT_DIRECTORY and config/openresty/locals.js's
# blog_static_files_dir/global_static_files_dir - the same mount
# blotcms/blot#1975 adds in production):
#   blog/hello.txt        - in the "blog" static dir (server.conf's `root`
#                            for the cdn. location) - found by try_files.
#   global/global-only.txt - in the "global" static dir ONLY - see the "cdn.
#                            file only in global static dir" corpus case for
#                            why this one is NOT currently found.
#
# The container's OpenResty worker runs as uid 1000 (ec2-user); a plain
# `mktemp -d` is 0700, owned by the runner (a different uid), so the worker
# could not even stat the file (open() ... Permission denied -> silently
# falls through to @cdn_node, which returns 200 too, so the wrong path
# passed the corpus's status-only sanity check without being caught - see
# the comment on `servedFromDisk` in corpus.js). Make the tree world-readable.
mkdir -p "$STATIC_DIR/blog" "$STATIC_DIR/global"
echo "differential-cdn-fixture" > "$STATIC_DIR/blog/hello.txt"
echo "differential-cdn-fixture-global-only" > "$STATIC_DIR/global/global-only.txt"
chmod 755 "$STATIC_DIR" "$STATIC_DIR/blog" "$STATIC_DIR/global"
chmod 644 "$STATIC_DIR/blog/hello.txt" "$STATIC_DIR/global/global-only.txt"

# server.conf's internal purge/inspect server binds 127.0.0.1:80 - loopback
# only, but on --network host that's the SAME loopback the client (curl,
# capture.js) uses, so it shadows the blog/custom-domain default_server for
# anything sent to 127.0.0.1:80: every corpus request landed there instead of
# a real vhost (all 404, same tiny body, none of the proxy's own headers -
# see run 35994257384, job 107615345726). Route every client request at the
# runner's own routable IP instead, the same fix zero-downtime/cert-issuance
# in integration.yml and the sibling proxy-fail2ban-check workflow use. (The
# stub upstream's own 127.0.0.1:8088-91 is unaffected - that's nginx's
# upstream connection, inside the shared network namespace, not a client
# request against the vhosts under test.)
HOSTIP="$(hostname -I | awk '{print $1}')"
echo "HOSTIP=$HOSTIP"

echo "--- starting redis + stub upstream ---"
docker run -d --name redis --network host redis:6.2.12-alpine
docker run -d --name stub --network host \
  -v "$SCRIPT_DIR/../e2e/stub-upstream.js:/s.js" node:22-alpine node /s.js

for i in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8088/ && break
  sleep 1
done

# Waits for a config's readiness endpoint, then runs the corpus against it.
# Host: blot.im over :443, against HOSTIP (see above - 127.0.0.1 would hit
# the internal purge/inspect server instead), hits blot-site.conf's
# `location = /health { return 200; }` directly - an EXACT server_name match
# (server.conf's "blot.im" server block, not the wildcard blog regex), so
# there's no ambiguity about which server block it lands on, and it doesn't
# depend on the stub, Redis, or any upstream being reachable - only that
# OpenResty parsed the config and is listening. (An earlier version of this
# probe used a made-up "readiness.blot.im" Host over :80, relying on the
# wildcard blog server's regex `server_name`; that landed on the
# custom-domain default_server instead and 404'd - see the "site /health"
# corpus case in corpus.js, which exercises the same location this probes.)
wait_ready() {
  local container="$1"
  local code
  for i in $(seq 1 30); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' -m 5 -H 'Host: blot.im' "https://$HOSTIP/health" || echo curl-error)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "$container did not become ready (last probe: https://$HOSTIP/health Host:blot.im -> '$code')" >&2
  echo "--- docker logs $container (stdout/stderr) ---" >&2
  docker logs "$container" >&2 2>&1 || true
  # The container config logs to stdout (LOG_TO_STDOUT, already above); the
  # bare-metal-in-a-container config logs to a file instead (see
  # build-baremetal-config.sh's OPENRESTY_LOG_DIRECTORY), which `docker logs`
  # does not show.
  echo "--- docker exec $container tail error.log ---" >&2
  docker exec "$container" tail -n 100 /var/log/openresty/error.log >&2 2>&1 || true
  return 1
}

echo "--- container config ---"
docker run -d --name proxy --network host --cap-add SYS_NICE \
  -e BLOT_HOST=blot.im -e PROXY_REDIS_HOST=127.0.0.1 -e PROXY_FETCH_CDN_IPS=false \
  -v "$STATIC_DIR/blog:/var/www/blot/data/static:ro" \
  -v "$STATIC_DIR/global:/var/www/blot/app/blog/static:ro" \
  blot-proxy:differential
wait_ready proxy
# capture.js exits non-zero when one of the corpus's own sanity checks fails
# (see corpus.js/capture.js) - a problem with this config, independent of the
# other one. Don't let that abort the script here: capture BOTH sides first
# (so a real diagnosis, and the bare-metal capture, aren't lost - see run
# 35994257384/job 107615345726, which stopped after the container side
# failed sanity), and fail the run at the end once both are in.
CONTAINER_SANITY_OK=1
DIFFERENTIAL_HOST="$HOSTIP" node capture.js container container-capture.json || CONTAINER_SANITY_OK=0
docker logs proxy > container.log 2>&1 || true
docker rm -f proxy >/dev/null

echo "--- bare-metal config ---"
docker run -d --name baremetal --network host --cap-add SYS_NICE \
  -v "$STATIC_DIR/blog:/var/www/blot/data/static:ro" \
  -v "$STATIC_DIR/global:/var/www/blot/app/blog/static:ro" \
  blot-proxy:baremetal-differential
wait_ready baremetal
BAREMETAL_SANITY_OK=1
DIFFERENTIAL_HOST="$HOSTIP" node capture.js baremetal baremetal-capture.json || BAREMETAL_SANITY_OK=0
docker logs baremetal > baremetal.log 2>&1 || true
docker rm -f baremetal >/dev/null

echo "--- diff ---"
DIFF_OK=1
node diff.js container-capture.json baremetal-capture.json || DIFF_OK=0

if [ "$CONTAINER_SANITY_OK" = 0 ] || [ "$BAREMETAL_SANITY_OK" = 0 ]; then
  echo "FAIL: sanity check(s) failed (container ok=$CONTAINER_SANITY_OK, bare-metal ok=$BAREMETAL_SANITY_OK) - see the 'SANITY FAIL' lines above. This is a problem with one config's own corpus results, independent of whether the cross-config diff below passed." >&2
  exit 1
fi
[ "$DIFF_OK" = 1 ]
