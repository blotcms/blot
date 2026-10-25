# Pinned for reproducible builds. 1.25.3.1 is the newest alpine-fat tag whose
# toolchain still compiles the sockproc helper (GCC 14 in later tags does not).
# Lua dependencies are fetched as version-pinned, checksummed .src.rock archives
# from luarocks.org rather than installed with the luarocks bundled in these
# images, whose remote manifest no longer loads.
ARG OPENRESTY_TAG=1.25.3.1-alpine-fat

# ---------------------------------------------------------------------------
# Stage 1: assemble the Lua dependencies the generated config loads
# ---------------------------------------------------------------------------
FROM openresty/openresty:${OPENRESTY_TAG} AS deps

RUN apk add --no-cache git make gcc musl-dev

WORKDIR /tmp/rocks

# resty.auto-ssl + its Lua dependencies (resty.http, shell-games). .src.rock
# files are plain zip archives laid out as <name>/lib/...
RUN set -eux; \
    fetch() { curl -fsSL -o "$1" "https://luarocks.org/$1"; echo "$2  $1" | sha256sum -c -; unzip -oq "$1"; }; \
    fetch lua-resty-auto-ssl-0.13.1-1.src.rock a6a1776a8f320f4ff5499c34dd296b4cf38c45165a978cc8d6d2b9824101c8df; \
    fetch lua-resty-http-0.17.2-0.src.rock    04ae92ca37f2d6c87ccd36e8f260566483d488274598f19bb54b7a911501b8be; \
    fetch shell-games-1.1.0-1.src.rock        a2d80aa83345587f942fb786d66531eaf7d36f87fed31503206f452de174eba5; \
    mkdir -p /vendor/lualib/resty /vendor/resty-auto-ssl; \
    cp -a lua-resty-auto-ssl/lib/resty/. /vendor/lualib/resty/; \
    cp -a lua-resty-http/lib/resty/.     /vendor/lualib/resty/; \
    cp -a lua-shell-games/lib/.          /vendor/lualib/; \
    cp -a lua-resty-auto-ssl/bin/.       /vendor/resty-auto-ssl/

# lua-resty-auto-ssl vendors this single file at build time (its Makefile
# curls it at a pinned commit); the .src.rock ships only a placeholder.
RUN curl -fsSL -o /vendor/lualib/resty/auto-ssl/vendor/shell.lua \
      "https://raw.githubusercontent.com/juce/lua-resty-shell/955243d70506c21e7cc29f61d745d1a8a718994f/lib/resty/shell.lua" && \
    echo "1db9590b05828572a59a67f4ec83210b86b233b6d13c7e3a1e9713d6e19d6974  /vendor/lualib/resty/auto-ssl/vendor/shell.lua" | sha256sum -c -

# `dehydrated` - the ACME client lua-resty-auto-ssl shells out to during cert
# issuance. The .src.rock does not ship it (the Makefile curls it), so without
# this the hook fails with "can't execute .../dehydrated: No such file".
#
# lua-resty-auto-ssl v0.13.1 pins dehydrated 0.6.5 (2019), whose JWS `kid`
# handling a current ACME server rejects ("Key ID (kid) in JWS header missing
# expected URL prefix"). Use maintained 0.7.2 instead - the hook contract
# (bin/resty-auto-ssl/letsencrypt_hooks) is unchanged and it tolerates any
# extra hooks 0.7.x adds. The bare-metal OpenResty install this
# replaced, now gone from the host, had the 0.6.5 pin.
ARG DEHYDRATED_TAG=v0.7.2
RUN curl -fsSL -o /vendor/resty-auto-ssl/dehydrated \
      "https://raw.githubusercontent.com/dehydrated-io/dehydrated/${DEHYDRATED_TAG}/dehydrated" && \
    echo "6f45ea1e9ad0d781ecc05ea7171036c4d3e0e10611f2080df6120458323c8d5b  /vendor/resty-auto-ssl/dehydrated" | sha256sum -c - && \
    chmod 0755 /vendor/resty-auto-ssl/dehydrated

# sockproc - used by lua-resty-auto-ssl to shell out during cert issuance.
# Pinned to the commit lua-resty-auto-ssl's own Makefile uses.
ARG SOCKPROC_COMMIT=92aba736027bb5d96e190b71555857ac5bb6b2be
RUN git clone https://github.com/juce/sockproc.git /tmp/sockproc && \
    git -C /tmp/sockproc checkout --detach "${SOCKPROC_COMMIT}" && \
    make -C /tmp/sockproc && \
    install -m 0755 /tmp/sockproc/sockproc /vendor/resty-auto-ssl/sockproc

# ---------------------------------------------------------------------------
# Stage 2: the Brotli filter, built as a dynamic module against the nginx
# source bundled in the pinned OpenResty release. That copy carries OpenResty's
# patches (some add struct fields), so the module is compiled against the same
# headers as the binary it loads into. The OpenResty images ship no Brotli
# support. The binary is already built --with-compat, so a --with-compat build
# of the module loads into it.
# ---------------------------------------------------------------------------
FROM openresty/openresty:${OPENRESTY_TAG} AS brotli

ARG OPENRESTY_VERSION=1.25.3.1
ARG OPENRESTY_SHA256=32ec1a253a5a13250355a075fe65b7d63ec45c560bbe213350f0992a57cd79df
ARG NGINX_VERSION=1.25.3
ARG NGX_BROTLI_COMMIT=53e0fb55f250f48fe80c0ddbf6c0f7103cdbaae1

RUN apk add --no-cache git cmake make gcc g++ musl-dev linux-headers \
      pcre-dev zlib-dev openssl-dev

WORKDIR /tmp/brotli-build

RUN curl -fsSL -o openresty.tar.gz "https://openresty.org/download/openresty-${OPENRESTY_VERSION}.tar.gz" && \
    echo "${OPENRESTY_SHA256}  openresty.tar.gz" | sha256sum -c - && \
    tar xzf openresty.tar.gz

# The module's brotli submodule is pinned by the commit's gitlink
RUN git clone https://github.com/google/ngx_brotli.git && \
    git -C ngx_brotli checkout --detach "${NGX_BROTLI_COMMIT}" && \
    git -C ngx_brotli submodule update --init --recursive

# The module links Brotli statically from deps/brotli/out; build the libraries
# position-independent (the module is a shared object) and without
# -march=native, so the image runs on any CPU of the target architecture.
RUN mkdir ngx_brotli/deps/brotli/out && cd ngx_brotli/deps/brotli/out && \
    cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON .. && \
    cmake --build . --config Release --target brotlienc -j"$(nproc)"

# The filter module compresses responses on the fly; the static module serves
# the .br copies diskcache.lua makes of cached bodies.
RUN cd "openresty-${OPENRESTY_VERSION}/bundle/nginx-${NGINX_VERSION}" && \
    ./configure --with-compat --add-dynamic-module=/tmp/brotli-build/ngx_brotli && \
    make modules && \
    mkdir -p /vendor/modules && \
    cp objs/ngx_http_brotli_filter_module.so objs/ngx_http_brotli_static_module.so /vendor/modules/

# ---------------------------------------------------------------------------
# Stage 3: the proxy image
# ---------------------------------------------------------------------------
FROM openresty/openresty:${OPENRESTY_TAG}

# brotli is the CLI diskcache.lua compresses stored bodies with, and
# findutils the GNU find (-printf) its sweeper, evict.sh, lists the cache with.
# gettext provides envsubst, which render-config.sh uses to fill in the
# runtime placeholders in the generated config
RUN apk add --no-cache bash openssl gettext brotli findutils

# Match the production convention (workers run as ec2-user)
RUN addgroup -S ec2-user && adduser -S -u 1000 -G ec2-user ec2-user

# Brotli filter and static modules, loaded with load_module in proxy/config/initial.conf
COPY --from=brotli /vendor/modules/ /usr/local/openresty/nginx/modules/
COPY --from=deps /vendor/lualib/ /usr/local/openresty/lualib/
# lua-resty-auto-ssl shells out to /usr/bin/resty-auto-ssl/start_sockproc,
# which runs ./sockproc next to it.
COPY --from=deps /vendor/resty-auto-ssl/ /usr/bin/resty-auto-ssl/
RUN chmod 0755 /usr/bin/resty-auto-ssl/*

# Per-container runtime dir for the health-probe Unix socket (see
# proxy/config/server.conf).
# entrypoint.sh also (re)creates and chowns it.
RUN mkdir -p /run/openresty

# Directories referenced by the generated config and by lua-resty-auto-ssl.
# The log and cache directories (and auto-ssl storage) must be writable by the
# worker user, which the generated config sets to ec2-user.
RUN mkdir -p /etc/resty-auto-ssl/storage \
    /etc/resty-auto-ssl/letsencrypt/conf \
    /etc/openresty /etc/ssl/private \
    /var/log/openresty /var/cache/openresty && \
    chmod 755 /etc/resty-auto-ssl && \
    chown -R ec2-user:ec2-user /var/log/openresty /var/cache/openresty /etc/resty-auto-ssl

# Self-signed placeholder certificate so `openresty -t` passes and the
# container boots without any ACME machinery. This image is build-only
# scaffolding - see proxy/README.md. At deploy time mount a real certificate
# over these two paths.
RUN openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -subj "/CN=blot-proxy-placeholder" \
      -keyout /etc/ssl/private/letsencrypt-domain.key \
      -out /etc/ssl/private/letsencrypt-domain.pem

# Copy the generated configuration. Run proxy/build/build.sh first to produce
# proxy/build/data/latest (CI does this in .github/workflows/proxy.yml).
# The generated config is a template: entrypoint.sh renders it to nginx.conf
# (render-config.sh) so the Redis host, upstreams, resolver and server label
# can be set with environment variables at `docker run` time. defaults.env
# holds the values used when they are not set; cdn-ips.default.conf is the
# Bunny edge list used when the current one cannot be fetched at start.
COPY build/data/latest/openresty.conf /usr/local/openresty/nginx/conf/nginx.conf.template
COPY build/data/latest/defaults.env /etc/openresty/defaults.env
COPY build/data/latest/cdn-ips.conf /etc/openresty/cdn-ips.default.conf
COPY build/data/latest/wildcard_cert.lua /etc/openresty/wildcard_cert.lua
COPY build/data/latest/ban.lua /etc/openresty/ban.lua
COPY build/data/latest/diskcache.lua /etc/openresty/diskcache.lua
COPY build/data/latest/html /etc/openresty/html

COPY render-config.sh /usr/local/bin/render-config
COPY evict.sh /usr/local/bin/diskcache-evict
RUN chmod +x /usr/local/bin/render-config /usr/local/bin/diskcache-evict

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Liveness for docker/compose and the readiness probe in
# proxy/deploy/blue-green.sh. Probes a per-container Unix socket so a
# blue/green overlap can't have the other container answer for this one.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS -o /dev/null --unix-socket /run/openresty/health.sock http://localhost/health || exit 1

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
