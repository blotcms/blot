#!/bin/bash
#
# Turn the generated nginx.conf.template into nginx.conf, and write the Bunny
# CDN edge list, from the container's environment. Run by entrypoint.sh on
# every start and by proxy/deploy/reload-config.sh before a reload.
#
# The template carries ${PROXY_*} placeholders (config/openresty/locals.js).
# For each one, the value is, in order: the container's environment, then
# defaults.env (baked in at build time from REDIS_IP, SERVER_LABEL and
# OPENRESTY_RESOLVER, and today's loopback upstreams).
#
#   PROXY_REDIS_HOST       Redis for certificates and the domain allowlist
#   PROXY_SERVER_LABEL     the Blot-Server response header
#   PROXY_RESOLVER         DNS resolver, e.g. "127.0.0.11" or "8.8.8.8 ipv6=off"
#   PROXY_UPSTREAM_GREEN   host:port of the master Node (webhooks, /clients)
#   PROXY_UPSTREAM_BLUE    host:port of the dashboard Node / failover
#   PROXY_UPSTREAM_YELLOW  host:port of the blog Node
#
# PROXY_FETCH_CDN_IPS=false skips fetching the Bunny edge list at start and
# uses the list baked into the image.
set -euo pipefail

CONF_DIR="${PROXY_CONF_DIR:-/usr/local/openresty/nginx/conf}"
ETC_DIR="${PROXY_ETC_DIR:-/etc/openresty}"
TEMPLATE="$CONF_DIR/nginx.conf.template"
DEFAULTS="$ETC_DIR/defaults.env"

names=()
while IFS='=' read -r name value; do
  [[ -z "$name" ]] && continue
  names+=("$name")
  # already set in the environment: that wins
  if [[ -z "${!name+x}" ]]; then
    export "$name=$value"
  fi
done < "$DEFAULTS"

# Only these are substituted, so nginx's own $variables are left alone
vars=""
for name in "${names[@]}"; do vars+="\${$name} "; done

envsubst "$vars" < "$TEMPLATE" > "$CONF_DIR/nginx.conf"

if grep -q '\${PROXY_' "$CONF_DIR/nginx.conf"; then
  echo "render-config: unsubstituted placeholders left in nginx.conf:" >&2
  grep -o '\${PROXY_[A-Z_]*}' "$CONF_DIR/nginx.conf" | sort -u >&2
  exit 1
fi

# Bunny edge IPs, exempt from rate limits (the geo block in http.conf includes
# this file). Fetch the current list; on any failure use the one baked in.
CDN_IPS="$ETC_DIR/cdn-ips.conf"
cp "$ETC_DIR/cdn-ips.default.conf" "$CDN_IPS"

if [[ "${PROXY_FETCH_CDN_IPS:-true}" != "false" ]]; then
  fetched=$(curl -fsS -m 10 https://bunnycdn.com/api/system/edgeserverlist 2>/dev/null \
    | tr -d '[]" \n\r' | tr ',' '\n' || true)
  # only addresses, so nothing else can be written into the nginx config
  addresses=$(printf '%s\n' "$fetched" | grep -E '^[0-9a-fA-F:.]+$' || true)
  if [[ -n "$addresses" ]]; then
    printf '%s\n' "$addresses" | sed 's/$/ 1;/' > "$CDN_IPS"
    echo "render-config: using $(wc -l < "$CDN_IPS" | tr -d ' ') Bunny edge IPs"
  else
    echo "render-config: could not fetch the Bunny edge list, using the baked-in list" >&2
  fi
fi
