#!/usr/bin/env bash
#
# Generates the bare-metal OpenResty configuration (config/openresty) into
# config/openresty/data/latest/, using the same generator that produces the
# config deployed to the real host (config/openresty/build-config.js).
#
# This mirrors proxy/build/build.sh, which does the same thing for the
# container's generator (proxy/build/index.js). The two generators share
# config/openresty/conf (the canonical templates) and config/openresty/locals.js
# (the values substituted into them); only the locals differ.
#
# Run before building proxy/differential/baremetal.Dockerfile.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# require("config") resolves to app/config.js via NODE_PATH
export NODE_PATH="${NODE_PATH:-$REPO_ROOT/app}"

# Placeholder upstream/redis addresses so `openresty -t` (and the differential
# run itself) is deterministic. locals.js only reads NODE_SERVER_IP as a
# required env var - config/openresty/conf/http.conf hardcodes the actual
# 127.0.0.1:8088-8090 upstream addresses for both generators (see
# config/openresty/locals.js's comment on `node_ip`).
export NODE_SERVER_IP="${NODE_SERVER_IP:-127.0.0.1}"
export REDIS_IP="${REDIS_IP:-127.0.0.1}"

# Log/cache paths and the lua_package_path fallback directory: point these at
# where proxy/differential/baremetal.Dockerfile puts the generated files
# inside the image, so the bare-metal config finds the same directories the
# proxy image's own generated config does (both images share the same base
# image and vendored Lua libs - see proxy/differential/baremetal.Dockerfile).
export OPENRESTY_LOG_DIRECTORY="${OPENRESTY_LOG_DIRECTORY:-/var/log/openresty}"
export OPENRESTY_CACHE_DIRECTORY="${OPENRESTY_CACHE_DIRECTORY:-/var/cache/openresty}"
export OPENRESTY_CONFIG_DIRECTORY="${OPENRESTY_CONFIG_DIRECTORY:-/etc/openresty}"
export OPENRESTY_USER="${OPENRESTY_USER:-ec2-user}"

# Do not depend on the BunnyCDN edge-IP list being reachable from CI (same
# reasoning as proxy/build/build.sh; see config/openresty/build-config.js).
export FETCH_CDN_IPS="${FETCH_CDN_IPS:-false}"

node "$SCRIPT_DIR/../../config/openresty/build-config.js" --skip-confirmation
