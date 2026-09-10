#!/bin/bash
#
# Generates the OpenResty configuration for the proxy container into
# proxy/build/data/latest/ (openresty.conf, cacher.lua, html/).
#
# Run this before `docker build proxy/`. CI runs the same script in
# .github/workflows/proxy.yml so there is a single source of truth for the
# environment the config is generated with.
#
# The paths below must match where proxy/Dockerfile copies the generated
# files inside the image.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

# require("config") resolves to app/config.js via NODE_PATH
export NODE_PATH="${NODE_PATH:-$REPO_ROOT/app}"

# Paths and user inside the container image - keep in sync with proxy/Dockerfile.
# OPENRESTY_USER must be a user that exists in the image and owns the log and
# cache directories (proxy/Dockerfile creates and chowns them to ec2-user).
export OPENRESTY_CONFIG_DIRECTORY="${OPENRESTY_CONFIG_DIRECTORY:-/etc/openresty}"
export OPENRESTY_LOG_DIRECTORY="${OPENRESTY_LOG_DIRECTORY:-/var/log/openresty}"
export OPENRESTY_CACHE_DIRECTORY="${OPENRESTY_CACHE_DIRECTORY:-/var/cache/openresty}"
export OPENRESTY_USER="${OPENRESTY_USER:-ec2-user}"

# Base domain the generated virtual hosts are built from (build-time value).
export BLOT_HOST="${BLOT_HOST:-blot.im}"

# ACME directory for on-demand custom-domain certificates. CI overrides this
# with a Pebble test server; production leaves it at the Let's Encrypt default.
export ACME_CA="${ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}"

# DNS resolver baked into the generated config (OCSP stapling + ACME).
export OPENRESTY_RESOLVER="${OPENRESTY_RESOLVER:-8.8.8.8 ipv6=off}"

# Container-oriented defaults: bind :80/:443 with SO_REUSEPORT so a second
# container can join during a blue/green handover, and log to stdout/stderr.
export ENABLE_REUSEPORT="${ENABLE_REUSEPORT:-true}"
export LOG_TO_STDOUT="${LOG_TO_STDOUT:-true}"

# The container is build-only scaffolding: there is no host node server or
# redis wired up yet. These placeholders keep the generated config valid so
# `openresty -t` passes. See proxy/README.md.
export NODE_SERVER_IP="${NODE_SERVER_IP:-127.0.0.1}"
export REDIS_IP="${REDIS_IP:-127.0.0.1}"

node "$SCRIPT_DIR/index.js" --skip-confirmation
