#!/bin/sh
#
# node-app's command in local development (Dockerfile target dev-unit, see
# ../docker-compose.yml): a unit, OpenResty with node-a and node-b, as
# production runs it, but from the bind-mounted source. Renders the OpenResty
# config for $BLOT_HOST from proxy/config as proxy/build/build.sh does for the
# image, with LOCAL_DEVELOPMENT=true (proxy/config/development*.conf), puts it
# where proxy/Dockerfile would, then runs the unit's supervisor
# (proxy/unit/supervisor.sh) with nodemon in place of node (node.sh). An edit
# to proxy/ takes a restart of node-app.
set -e
cd /usr/src/app

OUT=/tmp/proxy-build
rm -rf "$OUT"
# Access and error logs go to /var/log/openresty in the container, so the
# stack's output stays Node's
PROXY_BUILD_OUTPUT="$OUT" LOCAL_DEVELOPMENT=true FETCH_CDN_IPS=false LOG_TO_STDOUT=false \
  GLOBAL_STATIC_FILES_DIR=/usr/src/app/app/blog/static \
  bash proxy/build/build.sh >/dev/null

cp "$OUT/openresty.conf" /usr/local/openresty/nginx/conf/nginx.conf.template
cp "$OUT/defaults.env" /etc/openresty/defaults.env
cp "$OUT/cdn-ips.conf" /etc/openresty/cdn-ips.default.conf
cp "$OUT"/*.lua /etc/openresty/
rm -rf /etc/openresty/html
cp -R "$OUT/html" /etc/openresty/html

# While nodemon restarts Node, a page that reloads once it is back, in place
# of production's "offline" pages
for page in site blog; do
  cp scripts/development/unit/restarting.html "/etc/openresty/html/error-upstream-offline-$page.html"
done

# node-a and node-b each make up a session secret when there is none in .env,
# and a session started on one would not be valid on the other
export BLOT_SESSION_SECRET="${BLOT_SESSION_SECRET:-development-session-secret}"

export UNIT_NODE_COMMAND=/usr/src/app/scripts/development/unit/node.sh
exec /bin/sh proxy/unit/supervisor.sh
