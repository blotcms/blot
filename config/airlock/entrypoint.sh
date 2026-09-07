#!/bin/sh
#
# Airlock entrypoint.
#
#   1. Install the nftables egress filter (needs --cap-add=NET_ADMIN).
#   2. Start the tinyproxy forward proxy        (:8888,      user 'airlock').
#   3. Start headless Chromium                  (127.0.0.1:9221, user 'airlock').
#   4. Start nginx in front of Chromium         (:9222, all interfaces, user 'airlockfwd').
#
# If any of these fail we exit non-zero and let Docker's restart policy try
# again - a half-configured airlock must never fall back to "fetch anything".
# Ports are hardcoded to match egress.nft / nginx.conf / tinyproxy.conf,
# which hardcode them right back - there is no working way to override just
# one of these from the environment, so we don't pretend there is.

set -eu

CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium-browser}"

# ---------------------------------------------------------------------------
# 1. Egress filter
# ---------------------------------------------------------------------------
if ! nft -f /etc/airlock/egress.nft 2>/tmp/nft.err; then
    echo "airlock: FATAL: could not install egress filter" >&2
    echo "airlock: the container needs to run with --cap-add=NET_ADMIN" >&2
    sed 's/^/airlock: nft: /' /tmp/nft.err >&2 || true
    exit 1
fi
echo "airlock: egress filter installed"

# nginx runs as 'airlockfwd' (see egress.nft / Dockerfile) and needs these
# temp dirs to exist and be writable by that user.
mkdir -p /tmp/nginx-client /tmp/nginx-proxy /tmp/nginx-fastcgi \
         /tmp/nginx-uwsgi /tmp/nginx-scgi
chown -R airlockfwd:airlockfwd /tmp/nginx-client /tmp/nginx-proxy \
         /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi

echo "airlock: $(cat /etc/airlock/chromium-version 2>/dev/null || "$CHROMIUM_BIN" --version)"

# ---------------------------------------------------------------------------
# 2. Forward proxy (-d keeps it in the foreground and logs to stdout;
#    it still drops to the 'airlock' user per tinyproxy.conf)
# ---------------------------------------------------------------------------
tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf &
PROXY_PID=$!
echo "airlock: tinyproxy started on :8888 (pid ${PROXY_PID})"

# ---------------------------------------------------------------------------
# 3. Headless Chromium, as the unprivileged 'airlock' user, bound to
#    localhost (Alpine's build ignores --remote-debugging-address anyway).
#    --remote-allow-origins=* is required for a client to attach (Chrome >= 111).
#    The rest mirrors app/helper/screenshot/args.js: no disk cache, no
#    background network chatter (component/sync/domain-reliability/breakpad),
#    deterministic rendering.
# ---------------------------------------------------------------------------
su-exec airlock:airlock "$CHROMIUM_BIN" \
    --headless=new \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --hide-scrollbars \
    --mute-audio \
    --no-first-run \
    --no-default-browser-check \
    --no-experiments \
    --disable-extensions \
    --disable-plugins \
    --disable-breakpad \
    --disable-client-side-phishing-detection \
    --disable-sync \
    --disable-translate \
    --disable-default-apps \
    --disable-background-networking \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-component-update \
    --disable-domain-reliability \
    --disable-notifications \
    --disable-component-extensions-with-background-pages \
    --disable-dev-profile \
    --disable-cache \
    --disk-cache-size=0 \
    --media-cache-size=0 \
    --aggressive-cache-discard \
    --deterministic-fetch \
    --font-render-hinting=none \
    --autoplay-policy=user-gesture-required \
    --user-data-dir=/home/airlock/profile \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9221 \
    --remote-allow-origins=* &
CHROMIUM_PID=$!
echo "airlock: chromium started on 127.0.0.1:9221 (pid ${CHROMIUM_PID})"

# ---------------------------------------------------------------------------
# 4. nginx front: listens on all interfaces at :9222, forwards to Chromium
#    with Host reset to localhost and WebSocket upgrade carried through.
#    Runs as 'airlockfwd', NOT 'airlock' - see egress.nft.
# ---------------------------------------------------------------------------
su-exec airlockfwd:airlockfwd nginx -c /etc/airlock/nginx.conf -e stderr \
    -g "daemon off; pid /tmp/nginx.pid;" &
NGINX_PID=$!
echo "airlock: nginx front started on :9222 (pid ${NGINX_PID})"

# If any managed process exits, bring the whole container down so Docker
# restarts it cleanly rather than leaving a degraded airlock up.
wait -n
echo "airlock: a managed process exited - shutting down" >&2
kill "$PROXY_PID" "$CHROMIUM_PID" "$NGINX_PID" 2>/dev/null || true
exit 1
