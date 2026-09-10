#!/usr/bin/env bash
#
# Apply a CONFIG-ONLY change to the running containerised proxy without
# replacing the container (so the listening sockets are never dropped).
#
#   proxy/deploy/reload-config.sh <container-name> <host-conf-dir>
#
#   <host-conf-dir>  host directory bind-mounted at
#                    /usr/local/openresty/nginx/conf in the container. This
#                    script writes the regenerated nginx.conf there before
#                    validating and reloading, so a successful run always
#                    means the new config is live.
#
# NOT wired to production. See proxy/README.md "Deployment".
#
# The container must run with that directory bind-mounted read-write, e.g.:
#
#   docker run ... \
#     -v /host/openresty/conf:/usr/local/openresty/nginx/conf \
#     -v /host/openresty/cacher.lua:/etc/openresty/cacher.lua \
#     -v /host/openresty/html:/etc/openresty/html \
#     ...
#
# cacher.lua / html change rarely; if they did, copy them to their own mounts
# too (this script reports when they differ). For an IMAGE change (new base
# image, new Lua deps, Dockerfile edits) use proxy/deploy/blue-green.sh.
set -euo pipefail

CONTAINER="${1:?usage: reload-config.sh <container-name> <host-conf-dir>}"
CONF_DIR="${2:?usage: reload-config.sh <container-name> <host-conf-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$SCRIPT_DIR/../build/data/latest"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "No running container named '$CONTAINER'." >&2
  exit 1
fi
if [ ! -d "$CONF_DIR" ]; then
  echo "Config dir '$CONF_DIR' does not exist." >&2
  exit 1
fi

echo "Regenerating config (proxy/build/build.sh)"
bash "$SCRIPT_DIR/../build/build.sh"

echo "Installing $GEN/openresty.conf -> $CONF_DIR/nginx.conf"
cp "$GEN/openresty.conf" "$CONF_DIR/nginx.conf"
echo "NOTE: this installs nginx.conf only. If your change touched cacher.lua"
echo "      or html/, copy $GEN/{cacher.lua,html} to their own bind-mounts too."

echo "Validating new config inside $CONTAINER"
docker exec "$CONTAINER" /usr/local/openresty/bin/openresty -t

echo "Reloading $CONTAINER"
docker exec "$CONTAINER" /usr/local/openresty/bin/openresty -s reload

echo "Reloaded $CONTAINER with the regenerated config."
