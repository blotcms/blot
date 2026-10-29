# Every stage builds on the same node:alpine image as the Node app (the root
# Dockerfile), so the two can later be combined in one container. Keep
# NODE_BASE identical in both Dockerfiles: scripts/security/check-base-image.js
# (run in CI and by the daily advisories check) fails if they differ. It pins
# the release and the multi-architecture index digest.
#
# OpenResty is compiled in the `openresty` stage the way the official
# openresty/openresty:alpine image is (docker-openresty tag 1.31.1.1-1,
# alpine/Dockerfile: same configure flags and bundled OpenSSL and PCRE2),
# with every download checked against a pinned sha256. The `-fat` variant's
# extras are left out; see "Pinned dependencies" in proxy/README.md.
# Lua dependencies are fetched as version-pinned, checksummed .src.rock archives
# from luarocks.org rather than installed with a luarocks, whose remote manifest
# no longer loads.
ARG NODE_BASE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# The OpenResty release, shared by the openresty and brotli stages
ARG OPENRESTY_VERSION=1.31.1.1
ARG OPENRESTY_SHA256=65b78baadd3f0984055de89bf13f4a1932e5bfe9c31932037a134ea2b1a0ce42
ARG NGINX_VERSION=1.31.1

# ---------------------------------------------------------------------------
# Stage 0: OpenResty, built from source on the shared base
# ---------------------------------------------------------------------------
FROM ${NODE_BASE} AS openresty

ARG OPENRESTY_VERSION
ARG OPENRESTY_SHA256

# https://github.com/openresty/openresty-packaging/blob/master/alpine/openresty-openssl3/APKBUILD
ARG RESTY_OPENSSL_VERSION=3.5.6
ARG RESTY_OPENSSL_SHA256=deae7c80cba99c4b4f940ecadb3c3338b13cb77418409238e57d7f31f2a3b736
# OpenResty's patch for it, from the release tag
ARG RESTY_OPENSSL_PATCH_VERSION=3.5.5
ARG RESTY_OPENSSL_PATCH_SHA256=0a30cc762a9d72901e8415a33f7671bb68469d46121061e26afe7b718f47581e
ARG RESTY_OPENSSL_BUILD_OPTIONS="enable-camellia enable-seed enable-rfc3779 enable-cms enable-md2 enable-rc5 \
        enable-weak-ssl-ciphers enable-ssl3 enable-ssl3-method enable-md2 enable-ktls enable-fips \
        "

# https://github.com/openresty/openresty-packaging/blob/master/alpine/openresty-pcre2/APKBUILD
ARG RESTY_PCRE_VERSION=10.47
ARG RESTY_PCRE_SHA256=c08ae2388ef333e8403e670ad70c0a11f1eed021fd88308d7e02f596fcd9dc16
ARG RESTY_PCRE_BUILD_OPTIONS="--enable-jit --enable-pcre2grep-jit --disable-bsr-anycrlf --disable-coverage --disable-ebcdic --disable-fuzz-support \
    --disable-jit-sealloc --disable-never-backslash-C --enable-newline-is-lf --enable-pcre2-8 --enable-pcre2-16 --enable-pcre2-32 \
    --enable-pcre2grep-callout --enable-pcre2grep-callout-fork --disable-pcre2grep-libbz2 --disable-pcre2grep-libz --disable-pcre2test-libedit \
    --enable-percent-zt --disable-rebuild-chartables --enable-shared --disable-static --disable-silent-rules --enable-unicode --disable-valgrind \
    "

# https://github.com/openresty/openresty-packaging/blob/master/alpine/openresty/APKBUILD
ARG RESTY_CONFIG_OPTIONS="\
    --with-compat \
    --without-http_rds_json_module \
    --without-http_rds_csv_module \
    --without-lua_rds_parser \
    --without-mail_pop3_module \
    --without-mail_imap_module \
    --without-mail_smtp_module \
    --with-http_addition_module \
    --with-http_auth_request_module \
    --with-http_dav_module \
    --with-http_flv_module \
    --with-http_geoip_module=dynamic \
    --with-http_gunzip_module \
    --with-http_gzip_static_module \
    --with-http_image_filter_module=dynamic \
    --with-http_mp4_module \
    --with-http_random_index_module \
    --with-http_realip_module \
    --with-http_secure_link_module \
    --with-http_slice_module \
    --with-http_ssl_module \
    --with-http_stub_status_module \
    --with-http_sub_module \
    --with-http_v2_module \
    --with-http_v3_module \
    --with-http_xslt_module=dynamic \
    --with-ipv6 \
    --with-mail \
    --with-mail_ssl_module \
    --with-md5-asm \
    --with-sha1-asm \
    --with-stream \
    --with-stream_ssl_module \
    --with-stream_ssl_preread_module \
    --with-threads \
    "
ARG RESTY_LUAJIT_OPTIONS="--with-luajit-xcflags='-DLUAJIT_NUMMODE=2 -DLUAJIT_ENABLE_LUA52COMPAT'"
ARG RESTY_PCRE_OPTIONS="--with-pcre-jit"
ARG _RESTY_CONFIG_DEPS="--with-pcre \
    --with-cc-opt='-DNGX_LUA_ABORT_AT_PANIC -I/usr/local/openresty/pcre2/include -I/usr/local/openresty/openssl3/include' \
    --with-ld-opt='-L/usr/local/openresty/pcre2/lib -L/usr/local/openresty/openssl3/lib -Wl,-rpath,/usr/local/openresty/pcre2/lib:/usr/local/openresty/openssl3/lib' \
    "

# The official image's build dependencies. The three dynamic modules it builds
# (geoip, image_filter, xslt) are compiled but never loaded here, so their
# runtime libraries (gd, geoip, libxslt) are not installed in the final image.
RUN apk add --no-cache build-base binutils coreutils curl gd-dev geoip-dev \
      libxslt-dev linux-headers make perl-dev readline-dev zlib-dev patch

WORKDIR /tmp

RUN curl -fsSL -o openssl.tar.gz "https://github.com/openssl/openssl/releases/download/openssl-${RESTY_OPENSSL_VERSION}/openssl-${RESTY_OPENSSL_VERSION}.tar.gz" && \
    echo "${RESTY_OPENSSL_SHA256}  openssl.tar.gz" | sha256sum -c - && \
    curl -fsSL -o openssl.patch "https://raw.githubusercontent.com/openresty/openresty/v${OPENRESTY_VERSION}/patches/openssl-${RESTY_OPENSSL_PATCH_VERSION}-sess_set_get_cb_yield.patch" && \
    echo "${RESTY_OPENSSL_PATCH_SHA256}  openssl.patch" | sha256sum -c - && \
    tar xzf openssl.tar.gz && \
    cd "openssl-${RESTY_OPENSSL_VERSION}" && \
    patch -p1 < ../openssl.patch && \
    ./config shared zlib -g \
      --prefix=/usr/local/openresty/openssl3 \
      --libdir=lib \
      -Wl,-rpath,/usr/local/openresty/openssl3/lib \
      ${RESTY_OPENSSL_BUILD_OPTIONS} && \
    make -j"$(nproc)" && make install_sw

RUN curl -fsSL -o pcre2.tar.gz "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${RESTY_PCRE_VERSION}/pcre2-${RESTY_PCRE_VERSION}.tar.gz" && \
    echo "${RESTY_PCRE_SHA256}  pcre2.tar.gz" | sha256sum -c - && \
    tar xzf pcre2.tar.gz && \
    cd "pcre2-${RESTY_PCRE_VERSION}" && \
    CFLAGS="-g -O3" ./configure \
      --prefix=/usr/local/openresty/pcre2 \
      --libdir=/usr/local/openresty/pcre2/lib \
      ${RESTY_PCRE_BUILD_OPTIONS} && \
    CFLAGS="-g -O3" make -j"$(nproc)" && CFLAGS="-g -O3" make install

RUN curl -fsSL -o openresty.tar.gz "https://openresty.org/download/openresty-${OPENRESTY_VERSION}.tar.gz" && \
    echo "${OPENRESTY_SHA256}  openresty.tar.gz" | sha256sum -c - && \
    tar xzf openresty.tar.gz && \
    cd "openresty-${OPENRESTY_VERSION}" && \
    eval ./configure -j"$(nproc)" ${_RESTY_CONFIG_DEPS} ${RESTY_CONFIG_OPTIONS} ${RESTY_LUAJIT_OPTIONS} ${RESTY_PCRE_OPTIONS} && \
    make -j"$(nproc)" && make install

# Strip as the official image does with RESTY_STRIP_BINARIES, and drop what only
# a build needs (headers, static libraries, man pages, the resty CLI tools)
RUN rm -Rf /usr/local/openresty/openssl3/bin/c_rehash /usr/local/openresty/openssl3/lib/*.a /usr/local/openresty/openssl3/include && \
    rm -Rf /usr/local/openresty/pcre2/bin /usr/local/openresty/pcre2/share && \
    rm -Rf /usr/local/openresty/luajit/lib/*.a /usr/local/openresty/luajit/share/man && \
    find /usr/local/openresty -type f -perm -u+x \( -path '*/openssl3/*' -o -path '*/pcre2/*' -o -path '*/luajit/*' -o -path '*/nginx/*' \) \
      -exec strip --strip-unneeded '{}' \; 2>/dev/null || true

# ---------------------------------------------------------------------------
# Stage 1: assemble the Lua dependencies the generated config loads
# ---------------------------------------------------------------------------
FROM ${NODE_BASE} AS deps

RUN apk add --no-cache git make gcc musl-dev curl unzip

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
# Give its SIGCHLD handler an explicit prototype for modern C compilers;
# keep the upstream Makefile's -Wall -Werror checks.
ARG SOCKPROC_COMMIT=92aba736027bb5d96e190b71555857ac5bb6b2be
COPY patches/sockproc-sigchld.patch /tmp/sockproc-sigchld.patch
RUN git clone https://github.com/juce/sockproc.git /tmp/sockproc && \
    git -C /tmp/sockproc checkout --detach "${SOCKPROC_COMMIT}" && \
    git -C /tmp/sockproc apply /tmp/sockproc-sigchld.patch && \
    make -C /tmp/sockproc && \
    install -m 0755 /tmp/sockproc/sockproc /vendor/resty-auto-ssl/sockproc

# ---------------------------------------------------------------------------
# Stage 2: the Brotli filter, built as a dynamic module against the nginx
# source bundled in the pinned OpenResty release. That copy carries OpenResty's
# patches (some add struct fields), so the module is compiled against the same
# headers as the binary it loads into (the same verified tarball the `openresty`
# stage builds). OpenResty ships no Brotli support. The binary is already built --with-compat, so a --with-compat build
# of the module loads into it.
# ---------------------------------------------------------------------------
FROM ${NODE_BASE} AS brotli

ARG OPENRESTY_VERSION
ARG OPENRESTY_SHA256
ARG NGINX_VERSION
ARG NGX_BROTLI_COMMIT=53e0fb55f250f48fe80c0ddbf6c0f7103cdbaae1

RUN apk add --no-cache git cmake make gcc g++ musl-dev linux-headers curl \
      pcre2-dev zlib-dev openssl-dev

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
FROM ${NODE_BASE}

# What the image runs or shells out to, besides what the base provides:
# - bash: entrypoint.sh, render-config.sh and dehydrated
# - curl and ca-certificates: the healthcheck, the Bunny edge list fetch and
#   dehydrated's ACME requests
# - openssl: the CLI dehydrated signs requests with, and the placeholder
#   certificate below (the libssl OpenResty runs on is its own, in /usr/local/openresty)
# - gettext: envsubst, which render-config.sh uses to fill in the runtime
#   placeholders in the generated config
# - brotli: the CLI diskcache.lua compresses stored bodies with
# - findutils: the GNU find (-printf) the cache sweeper, evict.sh, lists with
# - libgcc, zlib: runtime libraries of the compiled binaries
RUN apk add --no-cache bash curl ca-certificates openssl gettext brotli findutils libgcc zlib

# The workers run as ec2-user (the generated config's `user` directive), uid
# 1000 to match the owner of the host's bind mounts. The base image already
# has user and group `node` at 1000, so rename them rather than add a second.
RUN deluser --remove-home node && \
    addgroup -g 1000 ec2-user && adduser -S -u 1000 -G ec2-user ec2-user

# OpenResty, built above
COPY --from=openresty /usr/local/openresty /usr/local/openresty
ENV PATH=$PATH:/usr/local/openresty/luajit/bin:/usr/local/openresty/nginx/sbin:/usr/local/openresty/bin
# As the official image: its default log paths go to the container's streams
RUN mkdir -p /usr/local/openresty/nginx/logs && \
    ln -sf /dev/stdout /usr/local/openresty/nginx/logs/access.log && \
    ln -sf /dev/stderr /usr/local/openresty/nginx/logs/error.log

# SIGQUIT drains in-flight requests (entrypoint.sh also traps SIGTERM)
STOPSIGNAL SIGQUIT

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
# What entrypoint.sh, and the unit image's supervisor, run before OpenResty
COPY start.sh /usr/local/bin/proxy-start
RUN chmod +x /usr/local/bin/render-config /usr/local/bin/diskcache-evict /usr/local/bin/proxy-start

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Liveness for docker/compose and the readiness probe in
# proxy/deploy/blue-green.sh. Probes a per-container Unix socket so a
# blue/green overlap can't have the other container answer for this one.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS -o /dev/null --unix-socket /run/openresty/health.sock http://localhost/health || exit 1

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
