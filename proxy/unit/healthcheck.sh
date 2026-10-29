#!/bin/sh
#
# The unit image's HEALTHCHECK: OpenResty's health socket (as in the proxy
# image) and node-a's /health on its own socket. node-b is not checked: node-a
# restarts it, and requests for it fall back to the other unit meanwhile.
# Node answers /health only for a loopback host, hence localhost.

curl -fsS -o /dev/null --unix-socket /run/openresty/health.sock http://localhost/health &&
  curl -fsS -o /dev/null --unix-socket "${BLOT_SOCKET:-/run/blot/$BLOT_UNIT-a.sock}" http://localhost/health
