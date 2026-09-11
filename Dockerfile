## Stage 1 (base)
# Runtime-only foundation shared by every downstream stage. It carries the
# things that must exist at *run* time (git, tini, pandoc, the libvips and
# ExifTool runtimes) but NOT the C/C++ toolchain or the -dev headers used to
# compile native npm modules - those live in the throwaway `deps` stage and
# never reach a published image. Keeping them out of `base` shrinks both the
# `dev` test image (pulled by all ~17 CI matrix jobs) and the `prod` image.
FROM node:22-alpine AS base

ARG PANDOC_VERSION=3.6.1
ARG TARGETPLATFORM

EXPOSE 8080

ENV NODE_ENV=production
ENV NODE_PATH=/usr/src/app/app

# Set the working directory in the Docker container
WORKDIR /usr/src/app

# Puppeteer is used only as a CDP client (it connect()s to the airlock's
# Chromium), so don't let `npm install` download its ~130MB bundled browser.
# The dev stage, which does launch() a local Chromium for tests, installs the
# system package and points Puppeteer at it instead.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install the git client and a few runtime basics. Chromium is NOT installed
# here: production takes screenshots by connecting to the shared "airlock"
# container's headless Chromium over the Docker network (see
# app/helper/screenshot and config/airlock), so the prod image ships no
# browser. The dev stage below adds Chromium back for the test suite.
#
# Also configure git to handle lots of large binary files in memory-constrained
# environments. Folded into one layer to keep the image's layer count (and so
# its per-job pull cost) down.
RUN apk add --no-cache git tini curl ca-certificates \
 && git config --system pack.threads 1 \
 && git config --system pack.windowMemory 32m \
 && git config --system pack.deltaCacheSize 32m \
 && git config --system pack.window 5

# Use tini as the init process so simple-git child processes are reaped instead of becoming zombies.
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
RUN apk add --no-cache \
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

RUN apk add --no-cache build-base python3 pkgconfig vips-dev

# Build sharp against the system libvips rather than its bundled prebuilt, so
# HEIC/HEVC decode (car.heic in app/build) works - the prebuilt libvips omits
# the HEVC codec. Matches how the pre-multi-stage image resolved sharp.
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1

# NODE_ENV=production (inherited) keeps this to runtime dependencies only.
RUN npm install --no-package-lock --omit=dev \
 && npm rebuild sharp --build-from-source --foreground-scripts \
 && node -e "const v=require('sharp').versions.vips; if (v!==require('child_process').execSync('pkg-config --modversion vips-cpp').toString().trim()) { console.error('sharp not linked against system libvips, got '+v); process.exit(1) }" \
 && npm cache clean --force

## Stage 3 (dev-deps) - THROWAWAY
# Layers the devDependencies (jasmine, nyc, nock, faker, ...; all pure JS, no
# native build) on top of the compiled prod modules. Still has the toolchain
# from `deps` available in the unlikely event a devDependency needs it.
FROM deps AS dev-deps

ENV NODE_ENV=development
# The re-resolve can swap sharp back to its prebuilt libvips; force it back onto
# the system libvips and confirm before this stage is copied forward.
RUN npm install --no-package-lock \
 && npm rebuild sharp --build-from-source --foreground-scripts \
 && node -e "const v=require('sharp').versions.vips; if (v!==require('child_process').execSync('pkg-config --modversion vips-cpp').toString().trim()) { console.error('sharp not linked against system libvips, got '+v); process.exit(1) }" \
 && npm cache clean --force

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
# local headless Chromium via Puppeteer. Production does not - it connects to
# the airlock - so the browser and its font/nss deps live in this stage only.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# config/redis/scripts/install-service-overrides.sh is written for the bash
# that ships on the production EC2 host and its test spawns it with `bash`
# directly - Alpine's base image only has busybox `sh`, so add the real thing.
RUN apk add --no-cache bash

# Configure git so the git client doesn't complain
RUN git config --global --add safe.directory /usr/src/app \
 && git config --global user.email "you@example.com" \
 && git config --global user.name "Your Name"

# OpenResty is spawned by config/openresty (cacher) tests via `openresty -c ...`.
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

## Stage 6 (default, production)
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
