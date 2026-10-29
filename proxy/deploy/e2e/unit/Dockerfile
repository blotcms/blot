# A stand-in for the unit image (the root Dockerfile's `unit` target), for
# proxy-deploy-e2e.yml: the real proxy image plus a stub in place of the app, so
# the real blue-green.sh can deploy a "unit" against real Docker without
# building and booting the app (which unit-image.yml's smoke test covers). The
# stub serves /health and every other path on the two sockets a unit's Node
# processes use (/run/blot/<unit>-a.sock and -b.sock), and the supervisor starts
# the proxy the way proxy/unit/supervisor.sh does, in unit mode.
#
#   docker build -f proxy/deploy/e2e/unit/Dockerfile -t blot-unit:e2e \
#     [--build-arg BREAK=a] [--label e2e.variant=b] proxy/deploy/e2e/unit
#
# BREAK=a makes node-a never listen, so the unit never becomes healthy.
ARG BASE=blot-proxy:e2e
FROM ${BASE}
ARG BREAK=
ENV STUB_BREAK=${BREAK}
COPY stub-node.js /usr/src/app/stub-node.js
COPY verify.js /usr/src/app/scripts/deploy/verify-container/index.js
COPY supervisor.sh /usr/local/bin/unit-supervisor
RUN chmod +x /usr/local/bin/unit-supervisor && mkdir -p /run/blot
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS -o /dev/null --unix-socket /run/openresty/health.sock http://localhost/health || exit 1
ENTRYPOINT ["/usr/local/bin/unit-supervisor"]
