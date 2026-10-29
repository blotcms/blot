#!/bin/bash
set -e

OPENRESTY="/usr/local/openresty/bin/openresty"

# Graceful shutdown: on SIGTERM/SIGQUIT drain in-flight requests with
# `openresty -s quit` instead of letting the container be killed. This is what
# makes the blue/green handover in proxy/deploy/blue-green.sh lossless - the
# replacement container is already in the SO_REUSEPORT group before this one
# leaves it.
term() {
  echo "Shutdown signal received - draining (openresty -s quit)."
  "$OPENRESTY" -s quit || true
  wait "$openresty_pid" 2>/dev/null || true
}
trap term TERM QUIT INT

# proxy-start (start.sh) prepares the container, then becomes OpenResty
/usr/local/bin/proxy-start "$OPENRESTY" -g "daemon off;" &
openresty_pid=$!
status=0
wait "$openresty_pid" || status=$?
# A signal cuts the wait short (status over 128) and term has drained and
# reaped OpenResty by then; otherwise this is OpenResty's, or proxy-start's
# when it could not prepare the container.
[[ "$status" -gt 128 ]] && status=0
exit "$status"
