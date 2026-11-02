# Keep NODE_BASE identical to the one in proxy/Dockerfile (the proxy image is
# built on the same base); scripts/security/check-base-image.js checks it.
ARG NODE_BASE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
## Stage 1 (base)
# Runtime-only foundation shared by every downstream stage. It carries the
# things that must exist at *run* time (git, tini, pandoc, the libvips and
# ExifTool runtimes) but NOT the C/C++ toolchain or the -dev headers used to
# compile native npm modules - those live in the throwaway `deps` stage and
# never reach a published image. Keeping them out of `base` shrinks both the
# `dev` test image (pulled by all ~17 CI matrix jobs) and the `prod` image.
FROM ${NODE_BASE} AS base

ARG PANDOC_VERSION=3.6.1
# sharp 0.35 needs libvips >= 8.18.6 but the Alpine release this base image is
# built on ships 8.18.2, so the vips packages (and whatever they pull in) come
# from Alpine edge. Drop these once the stable release catches up.
ARG ALPINE_EDGE="--repository=https://dl-cdn.alpinelinux.org/alpine/edge/main --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community"
ARG TARGETPLATFORM

EXPOSE 8080

ENV NODE_ENV=production
ENV NODE_PATH=/usr/src/app/app

# Set the working directory in the Docker container
WORKDIR /usr/src/app

# Don't let `npm install` download Puppeteer's ~130MB bundled browser. The
# stages that run Chromium install Alpine's: dev (tests launch() it) and unit
# (the sandbox's browser jail, below), and point Puppeteer at it.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install the git client and a few runtime basics. Chromium is NOT installed
# here: production takes screenshots in the sandbox's browser jail, and the
# unit stage adds the Chromium it runs. The dev stage adds one for the tests.
#
# Also configure git to handle lots of large binary files in memory-constrained
# environments. Folded into one layer to keep the image's layer count (and so
# its per-job pull cost) down.
#
# This is system config, so it applies to every git process in the container,
# including the git upload-pack / index-pack / pack-objects processes the git
# client spawns for clones and pushes (app/clients/git). pack.threads 1 stops
# index-pack and pack-objects taking every core. receive.maxInputSize caps a
# push just under the 2000M the proxy accepts for /clients/git/end/ (see
# proxy/config/blot-site.conf); receivePack.js reads it and passes it to
# index-pack, so one that is too big fails with a message the user can read
# rather than nginx's bare 413. Keep the two in step.
RUN apk add --no-cache git tini curl ca-certificates \
 && git config --system pack.threads 1 \
 && git config --system pack.windowMemory 32m \
 && git config --system pack.deltaCacheSize 32m \
 && git config --system pack.window 5 \
 && git config --system receive.maxInputSize 1900m

# Use tini as the init process so git child processes are reaped instead of becoming zombies.
ENTRYPOINT ["/sbin/tini", "--"]

# Install Pandoc. Version is pinned (build arg) for reproducible document
# conversion output across rebuilds.
RUN ARCH=$(echo ${TARGETPLATFORM} | sed -nE 's/^linux\/(amd64|arm64)$/\1/p') \
  && if [ -z "$ARCH" ]; then echo "Unsupported architecture: $TARGETPLATFORM" && exit 1; fi \
  && curl -L https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${ARCH}.tar.gz | tar xz \
  && mv pandoc-${PANDOC_VERSION}/bin/pandoc /usr/local/bin/pandoc \
  && chmod +x /usr/local/bin/pandoc \
  && rm -r pandoc-${PANDOC_VERSION}

# Runtime libraries only (the -dev headers and toolchain used to *compile*
# sharp live in the throwaway `deps` stage):
#  - `sharp` is built against the system libvips (see `deps`), so the final
#    image needs both libvips.so (vips) and libvips-cpp.so (vips-cpp) plus the
#    HEIC/AVIF decode path: vips-heif -> libheif -> its libde265 plugin. This
#    is what gives `car.heic` (HEVC-coded) a working decoder; sharp's own
#    prebuilt libvips ships without HEVC.
#  - exiftool pulls in the perl runtime it needs; used for image/file metadata.
# One layer, no apk cache left behind.
RUN apk add --no-cache --upgrade $ALPINE_EDGE \
    vips \
    vips-cpp \
    vips-heif \
    libheif \
    libheif-libde265 \
    libpng \
    libjpeg-turbo \
    libde265 \
    libwebp \
    exiftool \
 && exiftool -ver

# Copy package file and any install hooks required during npm install
# We don't create a package-lock.json because we ran into issues
# with sharp on different architectures. If we can solve this, then
# we can commit the package-lock.json and edit this step.
COPY package.json ./

## Stage 2 (deps) - THROWAWAY
# Compiles the native npm modules (sharp, re2) with a full C/C++ toolchain and
# the vips-dev headers, then hands only the resulting node_modules forward via
# `COPY --from`. None of g++/make/python3/pkgconfig/vips-dev ends up in any
# published image, so the ~250MB they weigh is no longer pulled by every CI job.
FROM base AS deps
ARG ALPINE_EDGE

RUN apk add --no-cache --upgrade $ALPINE_EDGE build-base python3 pkgconfig vips-dev

# Build sharp against the system libvips rather than its bundled prebuilt, so
# HEIC/HEVC decode (car.heic in app/build) works - the prebuilt libvips omits
# the HEVC codec. sharp 0.35 dropped its install-time build: `npm run build` in
# the package compiles src/build/Release, which sharp loads ahead of the
# prebuilt @img/* binaries. The bundled libvips reports an `aom` version and the
# system one doesn't, hence the check (comparing vips versions alone can match
# by coincidence).
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1

# NODE_ENV=production (inherited) keeps this to runtime dependencies only.
RUN npm install --no-package-lock --omit=dev \
 && npm install --no-save --no-package-lock node-addon-api node-gyp \
 && (cd node_modules/sharp && npm run build) \
 && node -e "const s=require('sharp'); const v=s.versions.vips; if ('aom' in s.versions || v!==require('child_process').execSync('pkg-config --modversion vips-cpp').toString().trim()) { console.error('sharp not linked against system libvips, got '+v); process.exit(1) }" \
 && npm cache clean --force

# Delete what can never be loaded at run time. node_modules is copied forward
# into every published image and unpacked by every CI job, so file count
# matters as much as bytes.
#  - node-gyp and node-addon-api (installed --no-save above) and re2's own
#    vendored C++ sources and node-gyp copy were only needed to compile; the
#    built addons (sharp/src/build, re2/build) stay. The `require`s below fail
#    the build if that ever stops being true.
#  - documentation, type declarations (read only by the TypeScript compiler,
#    which isn't installed), sourcemaps and changelogs. No .js/.json/.node/
#    .mjs/.cjs is ever touched.
# Prints the before/after numbers into the build log.
RUN echo "node_modules before prune: $(find node_modules -type f | wc -l) files, $(du -sm node_modules | cut -f1)MB" \
 && rm -rf node_modules/node-gyp node_modules/node-addon-api node_modules/re2/vendor node_modules/re2/node_modules \
 && find node_modules -type f \( \
      -name '*.md' -o -name '*.markdown' \
      -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' -o -name '*.d.ts.map' \
      -o -name 'CHANGELOG*' -o -name 'HISTORY*' -o -name 'CHANGES*' \
      -o -name '*.tsbuildinfo' \
    \) -delete \
 && node -e "require('sharp'); require('re2')" \
 && echo "node_modules after prune: $(find node_modules -type f | wc -l) files, $(du -sm node_modules | cut -f1)MB"

## Stage 3 (dev-deps) - THROWAWAY
# Layers the devDependencies (jasmine, nyc, nock, faker, ...; all pure JS, no
# native build) on top of the compiled prod modules. Still has the toolchain
# from `deps` available in the unlikely event a devDependency needs it.
FROM deps AS dev-deps

ENV NODE_ENV=development
# The re-resolve can swap sharp back to its prebuilt libvips; force it back onto
# the system libvips and confirm before this stage is copied forward.
RUN npm install --no-package-lock \
 && npm install --no-save --no-package-lock node-addon-api node-gyp \
 && (cd node_modules/sharp && npm run build) \
 && node -e "const s=require('sharp'); const v=s.versions.vips; if ('aom' in s.versions || v!==require('child_process').execSync('pkg-config --modversion vips-cpp').toString().trim()) { console.error('sharp not linked against system libvips, got '+v); process.exit(1) }" \
 && npm cache clean --force

# Same cleanup as in `deps` (see the comment there), now also covering the
# devDependencies.
RUN echo "node_modules before prune: $(find node_modules -type f | wc -l) files, $(du -sm node_modules | cut -f1)MB" \
 && rm -rf node_modules/node-gyp node_modules/node-addon-api node_modules/re2/vendor node_modules/re2/node_modules \
 && find node_modules -type f \( \
      -name '*.md' -o -name '*.markdown' \
      -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' -o -name '*.d.ts.map' \
      -o -name 'CHANGELOG*' -o -name 'HISTORY*' -o -name 'CHANGES*' \
      -o -name '*.tsbuildinfo' \
    \) -delete \
 && node -e "require('sharp'); require('re2')" \
 && echo "node_modules after prune: $(find node_modules -type f | wc -l) files, $(du -sm node_modules | cut -f1)MB"

## Stage 4 (development)
# The image the CI test matrix runs against. Source is NOT baked in - it's bind
# mounted at run time (see scripts/tests/invoke.sh and .github/workflows/node.yml)
# so this image only needs to change when dependencies or system packages do.
FROM base AS dev

ENV NODE_ENV=development
ENV PATH=/usr/src/app/node_modules/.bin:$PATH

# Prebuilt node_modules (prod deps compiled in `deps` + devDeps from `dev-deps`).
COPY --from=dev-deps /usr/src/app/node_modules ./node_modules

# Fail the build here rather than in a test shard if the runtime libvips
# closure copied into base can't satisfy the system-linked sharp addon.
RUN node -e "require('sharp'); console.log('sharp loads against libvips ' + require('sharp').versions.vips)"

# The test suite (app/site/tests) and scripts/development/translate launch a
# local headless Chromium via Puppeteer. Production runs Chromium only in the
# sandbox, from the unit stage's own install, so this one is for development.
#
# Alpine's chromium depends on mesa-gbm -> mesa -> llvm22-libs, which puts a
# ~180MB libLLVM.so.22.1 (plus the 40MB libgallium software rasteriser that
# links it) in the image. Chromium links only libgbm.so.1, which needs just
# libdrm/expat; libgallium and libLLVM are dlopen()ed by Mesa's EGL/GBM/DRI
# drivers, which headless Chromium doesn't use because it renders through its
# own bundled ANGLE/SwiftShader (libEGL.so, libGLESv2.so, libvulkan.so.1 in
# /usr/lib/chromium). Deleting them was checked: headless --screenshot and a
# Puppeteer launch/setContent/screenshot work identically. The rm must be in the
# same RUN as the install, otherwise the files stay in the earlier layer and the
# image doesn't shrink. If a Chromium upgrade ever needs them, the symptom is a
# launch failure in app/site/tests; drop this rm.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont \
 && rm -rf /usr/lib/libLLVM* /usr/lib/libgallium-*.so /usr/lib/dri
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Configure git so the git client doesn't complain
RUN git config --global --add safe.directory /usr/src/app \
 && git config --global user.email "you@example.com" \
 && git config --global user.name "Your Name"

# OpenResty is spawned by the proxy tests (the scanner ban) in proxy/tests via `openresty -c ...`.
# Alpine's community package installs the binary at /usr/lib/nginx/bin/openresty,
# which start-openresty.sh already probes for. procps provides the `ps` used when
# restarting OpenResty between specs; the /var dirs are nginx's compiled-in
# defaults for the pid file and logs.
RUN apk add --no-cache openresty sudo procps \
 && mkdir -p /var/run/nginx /var/log/nginx /var/tmp/nginx

## Stage 5 (copy in source)
# This gets our source code into builder for use in next two stages
# It gets its own stage so we don't have to copy twice
# this stage starts from `base` and skips the dev-only stages
FROM base AS source

WORKDIR /usr/src/app

# Runtime dependencies only (no devDependencies, no toolchain).
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy files and set ownership for non-root user.
# `app` is chown'd at COPY time rather than with a later `RUN chown -R`: a
# recursive chown rewrites every inode, so it would duplicate the whole ~380MB
# `app` tree into an extra layer that every deploy then has to pull. config,
# scripts and node_modules stay root-owned (the app only reads them).
COPY ./config ./config
COPY ./scripts ./scripts
COPY --chown=1000:1000 ./app ./app
COPY ./TODO ./TODO

## Stage 6 (production)
# The final production stage
FROM source AS prod

HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --start-interval=5s --retries=3 \
  CMD curl --fail http://localhost:8080/health || exit 1

# Ensure the data directory exists (empty; in production the shared data
# directory is mounted over this location). `app` is already owned by 1000:1000
# from the COPY --chown above, so no recursive chown is needed here.
RUN mkdir -p /usr/src/app/data && chown 1000:1000 /usr/src/app/data

# Change to the non-root user for the rest of the Dockerfile (ec2-user)
USER 1000

# Re-configuring git for the non-root user
RUN git config --global user.email "you@example.com" && git config --global user.name "Your Name"

# Build the documentation
RUN node app/documentation/build

CMD ["node", "/usr/src/app/app/index.js"]

## Stage 7 (unit; build it with --target, the app image is --target prod)
# One container holding OpenResty and the Node app, run as one of two units
# (#2119): the `prod` stage plus the proxy's runtime, started by a supervisor
# (proxy/unit/supervisor.sh) under tini. Built and tested in CI by
# .github/workflows/unit-image.yml.
# proxy/Dockerfile, built on the same NODE_BASE: the `unit` stage takes OpenResty
# and the proxy's files from it. CI builds it in the same build (the bake file
# supplies it as the blot-proxy context); locally it is the image tagged
# blot-proxy.
## Stage (nsjail) - THROWAWAY
# Builds nsjail, the sandbox the unit runs untrusted bytes in (#2257,
# app/sandbox/README.md). Only the binary reaches the unit. Alpine has no
# static protobuf, so it links the shared libraries, and they must come from
# the same Alpine edge as the unit's runtime ones (the unit stage installs
# them): a mix of abseil versions does not start, and `nsjail --help` in the
# unit stage fails the build if so. The commit is checked, not just the tag.
FROM base AS nsjail
ARG ALPINE_EDGE
ARG NSJAIL_VERSION=3.6
ARG NSJAIL_COMMIT=f78475530b46d0186111a9096b30725f816b55fe

RUN apk add --no-cache --upgrade $ALPINE_EDGE \
    build-base bison flex protobuf-dev libnl3-dev linux-headers git pkgconf bsd-compat-headers

# -Werror off and -D_LARGEFILE64_SOURCE for musl (its rlim_t is long long)
RUN git clone --depth 1 --branch ${NSJAIL_VERSION} https://github.com/google/nsjail.git /nsjail \
 && cd /nsjail \
 && [ "$(git rev-parse HEAD)" = "${NSJAIL_COMMIT}" ] \
 && git submodule update --init \
 && sed -i s/-Werror// Makefile \
 && make -j4 USER_DEFINES="-D_LARGEFILE64_SOURCE -DNDEBUG" \
 && strip nsjail

FROM blot-proxy AS proxy

FROM prod AS unit
ARG ALPINE_EDGE

# proxy/deploy/blue-green.sh refuses to deploy an image without this label
LABEL im.blot.kind=unit

USER root

# The runtime packages of the proxy image (see proxy/Dockerfile for why each),
# and su-exec, which starts Node as the app user: OpenResty's master stays root
# to bind 80 and 443, as in the proxy image, and drops its workers to ec2-user
RUN apk add --no-cache bash openssl gettext brotli findutils libgcc zlib su-exec

# One user at uid 1000 for the app and the proxy's workers (the generated
# config's `user` directive names ec2-user). Keep the node user's home, which
# holds the git config set above.
RUN deluser node \
 && addgroup -g 1000 ec2-user \
 && adduser -S -u 1000 -G ec2-user -h /home/node -H ec2-user

COPY --from=proxy /usr/local/openresty /usr/local/openresty
COPY --from=proxy /usr/bin/resty-auto-ssl /usr/bin/resty-auto-ssl
COPY --from=proxy /etc/openresty /etc/openresty
# The placeholder certificate, which a deploy mounts over
COPY --from=proxy /etc/ssl/private /etc/ssl/private
COPY --from=proxy /usr/local/bin/render-config /usr/local/bin/diskcache-evict /usr/local/bin/proxy-start /usr/local/bin/
ENV PATH=$PATH:/usr/local/openresty/luajit/bin:/usr/local/openresty/nginx/sbin:/usr/local/openresty/bin

# Directories the generated config and lua-resty-auto-ssl write to, and
# /run/blot, where each unit's Node processes serve on Unix sockets
RUN mkdir -p /etc/resty-auto-ssl/storage /etc/resty-auto-ssl/letsencrypt/conf \
    /var/log/openresty /var/cache/openresty /run/openresty /run/blot \
 && chmod 755 /etc/resty-auto-ssl \
 && chown -R ec2-user:ec2-user /etc/resty-auto-ssl /var/log/openresty /var/cache/openresty /run/blot

# The sandbox (app/sandbox, off unless the host sets BLOT_SANDBOX). nsjail's
# shared libraries come from the same Alpine edge it was built against. Chromium
# for the browser job has to come from there too, in one transaction: the stable
# one pulls abseil back down, and nsjail no longer starts. The rm is the dev
# stage's (see there). The rest is what the jail's network needs; setpriv
# replaces busybox's, which can't clear the bounding set.
RUN apk add --no-cache --upgrade $ALPINE_EDGE protobuf libnl3 \
    chromium nss freetype harfbuzz ttf-freefont font-noto-emoji \
    passt nftables setpriv tinyproxy \
 && rm -rf /usr/lib/libLLVM* /usr/lib/libgallium-*.so /usr/lib/dri \
 && chromium-browser --version
COPY --from=nsjail /nsjail/nsjail /usr/local/bin/nsjail
# The broker runs as root, so its files are root-owned and read-only to the
# app (uid 1000 rewrites /usr/src/app, so root must never load code from there)
COPY proxy/unit/sandbox/broker.js proxy/unit/sandbox/jail.js proxy/unit/sandbox/proxy.js \
     proxy/unit/sandbox/policy.kafel proxy/unit/sandbox/policy-browser.kafel \
     proxy/unit/sandbox/network.cfg proxy/unit/sandbox/network-proxy-blue.cfg \
     proxy/unit/sandbox/network-proxy-green.cfg proxy/unit/sandbox/tinyproxy.conf \
     proxy/unit/sandbox/egress.nft proxy/unit/sandbox/egress-proxy.nft \
     proxy/unit/sandbox/enter-network.sh proxy/unit/sandbox/node-filter.js \
     proxy/unit/sandbox/cgroup.js \
     /usr/local/lib/blot-sandbox/
RUN node /usr/local/lib/blot-sandbox/node-filter.js > /usr/local/lib/blot-sandbox/node.seccomp \
 && chmod -R go-w /usr/local/lib/blot-sandbox \
 && nsjail --help >/dev/null \
 && setpriv --no-new-privs --seccomp-filter /usr/local/lib/blot-sandbox/node.seccomp true

COPY proxy/unit/supervisor.sh /usr/local/bin/unit-supervisor
COPY proxy/unit/healthcheck.sh /usr/local/bin/unit-healthcheck
RUN chmod +x /usr/local/bin/unit-supervisor /usr/local/bin/unit-healthcheck

# Both halves: OpenResty's health socket and Node's /health on its own socket.
# The start period covers the app's start-up, as for `prod`.
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --start-interval=5s --retries=3 \
  CMD ["/usr/local/bin/unit-healthcheck"]

EXPOSE 80 443

# tini (the base image's entrypoint) is PID 1; it runs the supervisor
CMD ["/usr/local/bin/unit-supervisor"]
