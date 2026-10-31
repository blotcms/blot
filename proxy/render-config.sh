#!/bin/bash
#
# Turn the generated nginx.conf.template into nginx.conf, and write the Bunny
# CDN edge list, from the container's environment. Run by entrypoint.sh on
# every start.
#
# The template carries ${PROXY_*} placeholders (proxy/build/locals.js).
# For each one, the value is, in order: the container's environment, then
# defaults.env (baked in at build time from REDIS_IP, SERVER_LABEL and
# OPENRESTY_RESOLVER, and today's loopback upstreams).
#
#   PROXY_REDIS_HOST       Redis for certificates and the domain allowlist: a host
#                          (port 6379) or unix:/path/to/redis.sock
#   PROXY_SERVER_LABEL     the Blot-Server response header
#   PROXY_RESOLVER         DNS resolver, e.g. "127.0.0.11" or "8.8.8.8 ipv6=off"
#   PROXY_UNIT             blue or green: logged as unit= in the access log ("-" if unset)
#   PROXY_UPSTREAM_MODE    unit (the only mode): this container's own Node processes, below
#   PROXY_UNIT_MAIN        this unit's main Node process (blogs, dashboard reads)
#   PROXY_UNIT_WORKER      this unit's worker child (/clients, writes, webhooks)
#   PROXY_PEER_MAIN        the other unit's main process, as backup
#   PROXY_PEER_WORKER      the other unit's worker child, as backup
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

# The primary and backup server of each upstream group in http.conf. Set here,
# never taken from the environment.
if [[ "$PROXY_UPSTREAM_MODE" != unit ]]; then
  echo "render-config: PROXY_UPSTREAM_MODE must be unit, not '$PROXY_UPSTREAM_MODE'" >&2
  exit 1
fi
PROXY_NODE_PRIMARY="$PROXY_UNIT_WORKER";         PROXY_NODE_BACKUP="$PROXY_PEER_WORKER"
PROXY_BLOGS_PRIMARY="$PROXY_UNIT_MAIN";          PROXY_BLOGS_BACKUP="$PROXY_PEER_MAIN"
PROXY_DASHBOARD_PRIMARY="$PROXY_UNIT_MAIN";      PROXY_DASHBOARD_BACKUP="$PROXY_PEER_MAIN"
export PROXY_NODE_PRIMARY PROXY_NODE_BACKUP PROXY_BLOGS_PRIMARY PROXY_BLOGS_BACKUP \
  PROXY_DASHBOARD_PRIMARY PROXY_DASHBOARD_BACKUP

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
