# Airlock: the single egress boundary for fetching untrusted, user-supplied
# URLs from Blot's build pipeline.
#
#   * Chromium (headless), DevTools on 127.0.0.1:9221, fronted by nginx on
#     :9222 - used by app/helper/screenshot to screenshot bookmark links.
#   * tinyproxy on :8888 - an HTTP(S) forward proxy that app/helper/transformer
#     /download points node-fetch at, so downloads of remote assets referenced
#     in posts leave from inside this container's network namespace.
#
# entrypoint.sh installs an nftables egress filter (egress.nft) that REJECTs
# every private / link-local / ULA / special-use destination - including the
# cloud metadata address 169.254.169.254 - before any service starts, and
# also confines loopback so Chromium/tinyproxy can't reach this container's
# own services on 127.0.0.1 on a user's behalf. Because the filter matches
# the real destination IP at connect() time, in kernel, it also defeats
# DNS-rebinding and covers redirects and sub-resources that
# application-level URL checks miss.
#
# Run with:  --cap-add=NET_ADMIN            (to install the ruleset)
# Keep it on a Docker network shared ONLY with the Blot app containers - the
# DevTools endpoint and the proxy are unauthenticated, so network scope is the
# access control.
#
# See config/airlock/README.md for the full rationale, deploy steps, and the
# known user-controlled fetches this container does NOT yet cover.

FROM alpine:3.20

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    font-noto-emoji \
    ca-certificates \
    tinyproxy \
    nginx \
    nftables \
    su-exec \
    tini \
    curl

# 'airlock' runs Chromium and tinyproxy - the two processes that handle
# user-supplied URLs. 'airlockfwd' runs nginx, the internal DevTools front -
# a distinct uid so egress.nft can let nginx's Chromium hop use loopback
# while denying it to everything that touches untrusted input. See the
# "Loopback is NOT blanket-accepted" comment in egress.nft.
RUN addgroup -S airlock \
 && adduser -S -G airlock -u 1001 -h /home/airlock airlock \
 && addgroup -S airlockfwd \
 && adduser -S -G airlockfwd -u 1002 -h /var/lib/nginx airlockfwd \
 && mkdir -p /home/airlock/profile /var/lib/nginx/logs /var/log/nginx \
 && chown -R airlock:airlock /home/airlock \
 && chown -R airlockfwd:airlockfwd /var/lib/nginx /var/log/nginx

# Record the Chromium version this image ships at build time, so a version
# drift against the puppeteer version pinned in package.json shows up as a
# diff in this layer instead of only at runtime. Puppeteer's CDP client is
# tolerant of a browser-version gap until it suddenly isn't - if bookmark
# screenshots break after a base-image bump, check this file first.
RUN mkdir -p /etc/airlock && chromium-browser --version | tee /etc/airlock/chromium-version

COPY egress.nft /etc/airlock/egress.nft
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY nginx.conf /etc/airlock/nginx.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV CHROMIUM_BIN=/usr/bin/chromium-browser

EXPOSE 9222 8888

# Checks both services locally, with no outbound traffic: the DevTools HTTP
# endpoint via the nginx front, and tinyproxy's stats page (StatHost).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null \
   && curl -fsS -x "http://127.0.0.1:8888" "http://tinyproxy.stats/" >/dev/null \
   || exit 1

# No USER: the entrypoint must start as root to install the nft ruleset,
# then drops to 'airlock' / 'airlockfwd' with su-exec.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
