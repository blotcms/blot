#!/usr/bin/env bash
#
# Runs the REAL proxy/deploy/blue-green.sh for <image> while a loop sends one
# HTTPS request every 50 ms to the canary blog, and fails if any of them did not
# get a 200. For proxy-deploy-e2e.yml.
#
#   proxy/deploy/e2e/deploy-under-load.sh <image>
#
# Needs PROXY_CANARY_HOST and the PROXY_* settings the workflow exports.
#
# HTTPS with --connect-to (the technique https_status() in common.sh uses). A
# plain-HTTP request to 127.0.0.1 with only a Host header got 404 for every
# attempt: server.conf's internal purge server also `listen`s on 127.0.0.1:80,
# a more specific bind than the vhosts' `listen 80`, so nginx sends a
# connection that literally targets 127.0.0.1 there regardless of Host header.
# HTTPS on the same address does not hit it.
set -euo pipefail

IMAGE="${1:?usage: deploy-under-load.sh <image>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PROXY_CANARY_HOST:?}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
codes="$WORK/codes.txt"; : > "$codes"

# A stopping unit closes its listening sockets; a connection that finished its
# handshake in its queue but was not accepted yet is reset unless the kernel
# (5.14+) hands it to the other listener. Production may not have this set; it
# is set here so the run does not flake (see proxy/deploy/e2e/README.md).
sudo sh -c 'echo 1 > /proc/sys/net/ipv4/tcp_migrate_req' 2>/dev/null || true

# One request, as a browser sends it (HTTP/2, which the proxy offers). It is
# retried once, on a new connection, only when the server answered with GOAWAY
# (NO_ERROR, last stream 0): "I did not process your request, send it again"
# (RFC 9113 section 6.8), which browsers and HTTP/2 libraries do. nginx sends it
# and closes the connection when a worker starts to quit (what `docker stop`
# does to the unit being replaced) and the connection has finished its TLS
# handshake but not yet had a request processed. curl does not retry on its own,
# so about one request in 50 deploys failed with curl exit 55 ("Failed sending
# HTTP request"), never over HTTP/1.1. Anything else still counts as a failure.
# See proxy/deploy/e2e/README.md.
request() {
  curl -sv -o /dev/null -w '%{http_code}\n' --max-time 5 \
    --connect-to "$PROXY_CANARY_HOST:443:127.0.0.1:443" "https://$PROXY_CANARY_HOST/" \
    2>"$WORK/err.$1"
}

load_worker() {
  local code
  # No --retry: every attempt is recorded as-is, so a single refused or dropped
  # request during the deploy shows up as non-200.
  while [ ! -e "$WORK/done" ]; do
    code=$(request "$1") || code=curl-err
    if [ "$code" != 200 ] && grep -q 'received GOAWAY, error=0, last_stream=0' "$WORK/err.$1"; then
      echo "$1" >> "$WORK/retried.txt"
      code=$(request "$1") || code=curl-err
    fi
    echo "$code" >> "$codes"
    sleep 0.05
  done
}

load_worker 1 &
loop=$!
sleep 1
rc=0
bash "$HERE/../blue-green.sh" "$IMAGE" || rc=$?
sleep 2
touch "$WORK/done"
wait "$loop"

total=$(wc -l < "$codes"); bad=$(grep -vc '^200$' "$codes" || true)
echo "total=$total bad=$bad"; sort "$codes" | uniq -c
echo "retried after a GOAWAY that processed none of them: $( [ -e "$WORK/retried.txt" ] && wc -l < "$WORK/retried.txt" || echo 0 )"
[ "$rc" -eq 0 ] || { echo "blue-green.sh exited $rc" >&2; exit "$rc"; }
[ "$total" -ge 50 ] || { echo "only $total requests: the run means nothing" >&2; exit 1; }
[ "$bad" -eq 0 ] || { echo "$bad requests did not get a 200" >&2; exit 1; }
