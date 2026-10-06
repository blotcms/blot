#!/usr/bin/env bash
#
# Generates the bare-metal OpenResty configuration (config/openresty) into
# config/openresty/data/latest/, using the same generator that produces the
# config deployed to the real host (config/openresty/build-config.js).
#
# Copied from proxy/differential/build-baremetal-config.sh (sibling PR #1977,
# branch claude/proxy-differential-tests) rather than depended on, so this
# harness does not need that PR merged first - see proxy/deploy/e2e/README.md.
# Keep the two in sync; whichever of #1977 / this PR merges second should
# dedupe them.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

# require("config") resolves to app/config.js via NODE_PATH
export NODE_PATH="${NODE_PATH:-$REPO_ROOT/app}"

# Placeholder upstream/redis addresses so `openresty -t` (and this harness) is
# deterministic. locals.js only reads NODE_SERVER_IP as a required env var -
# config/openresty/conf/http.conf hardcodes the actual 127.0.0.1:8088-8090
# upstream addresses for both generators (see config/openresty/locals.js's
# comment on `node_ip`).
export NODE_SERVER_IP="${NODE_SERVER_IP:-127.0.0.1}"
export REDIS_IP="${REDIS_IP:-127.0.0.1}"

# Log/cache paths and the lua_package_path fallback directory: point these at
# where proxy/deploy/e2e/baremetal.Dockerfile puts the generated files inside
# the image, so the bare-metal config finds the same directories the proxy
# image's own generated config does (both images share the same base image
# and vendored Lua libs - see baremetal.Dockerfile).
export OPENRESTY_LOG_DIRECTORY="${OPENRESTY_LOG_DIRECTORY:-/var/log/openresty}"
export OPENRESTY_CACHE_DIRECTORY="${OPENRESTY_CACHE_DIRECTORY:-/var/cache/openresty}"
export OPENRESTY_CONFIG_DIRECTORY="${OPENRESTY_CONFIG_DIRECTORY:-/etc/openresty}"
export OPENRESTY_USER="${OPENRESTY_USER:-ec2-user}"

# Bare metal already listens for Node's cache purges today (locals.js's
# common() reads this for both generators) - proxy/deploy/common.sh's
# purge_reachable() checks that endpoint in preflight, against whichever side
# is currently serving, so bare metal needs it too, not just the container.
export OPENRESTY_INSTANCE_PRIVATE_IP="${OPENRESTY_INSTANCE_PRIVATE_IP:-127.0.0.1}"

# config/openresty/locals.js's baremetal() takes blog_static_files_dir /
# global_static_files_dir from require("config") (config/index.js), which
# derives both from BLOT_DIRECTORY - not overridable per-variable like the
# container side's BLOG_STATIC_FILES_DIR/GLOBAL_STATIC_FILES_DIR. Without this,
# BLOT_DIRECTORY defaults to the checkout root (config/index.js), so the
# generated bare-metal config would bake in static-file paths that don't match
# /var/www/blot, the paths proxy/deploy/common.sh's run_args() mounts
# PROXY_BLOG_STATIC_DIR/PROXY_GLOBAL_STATIC_DIR at for the container side.
export BLOT_DIRECTORY="${BLOT_DIRECTORY:-/var/www/blot}"

# Do not depend on the BunnyCDN edge-IP list being reachable from CI (same
# reasoning as proxy/build/build.sh; see config/openresty/build-config.js).
export FETCH_CDN_IPS="${FETCH_CDN_IPS:-false}"

node "$SCRIPT_DIR/../../../config/openresty/build-config.js" --skip-confirmation
