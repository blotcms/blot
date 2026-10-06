#!/usr/bin/env bash
# Behavioural checks for the built proxy image against a stub upstream
# (proxy/e2e/stub-upstream.js). No real app involved - this proves the
# generated production config's routing, caching, compression and hardening.
#
#   PROXY_HTTP   http base URL   (default http://127.0.0.1:8080)
#   PROXY_HTTPS  https base URL  (default https://127.0.0.1:8443)
#
# The image must have been generated/built with BLOT_HOST=localhost.
set -u

HTTP="${PROXY_HTTP:-http://127.0.0.1:8080}"
HTTPS="${PROXY_HTTPS:-https://127.0.0.1:8443}"
fail=0

code() { curl -sk -o /dev/null -m 10 -w '%{http_code}' "$@"; }
hdr()  { curl -sk -D - -o /dev/null -m 10 "$@"; }

expect() { # <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ok  - $1"
  else
    echo "  FAIL - $1 (got '$2', want '$3')"
    fail=1
  fi
}
expect_match() { # <label> <haystack> <needle>
  case "$2" in
    *"$3"*) echo "  ok  - $1" ;;
    *) echo "  FAIL - $1 (got '$2', want ~ '$3')"; fail=1 ;;
  esac
}

echo "routing"
expect "proxy /health (blog host)"        "$(code -H 'Host: someblog.example' "$HTTP/health")" 200
expect "site host / over https"           "$(code -H 'Host: localhost' "$HTTPS/")" 200
expect "site host / redirects on http"    "$(code -H 'Host: localhost' "$HTTP/")" 301
expect "custom domain / (default server)" "$(code -H 'Host: someblog.example' "$HTTP/")" 200

echo "cdn. static files"
# integration.yml mounts a file under the global static dir; this proves
# location @cdn_global in server.conf actually serves it from disk (with
# location /'s headers) rather than falling through to @cdn_node.
expect "cdn. serves a file from the global static dir" \
  "$(code -H 'Host: cdn.localhost' "$HTTP/cdn-test.txt")" 200
expect_match "cdn. sets the long Cache-Control for it" \
  "$(hdr -H 'Host: cdn.localhost' "$HTTP/cdn-test.txt")" "Cache-Control: public, max-age=31536000"
expect_match "cdn. sets CORS for it" \
  "$(hdr -H 'Host: cdn.localhost' "$HTTP/cdn-test.txt")" "Access-Control-Allow-Origin: *"

echo "hardening (blog traffic)"
# nginx `return 444` closes the connection with no HTTP response; curl reports 000.
expect "/.git/config blocked"   "$(code -H 'Host: someblog.example' "$HTTP/.git/config")" 000
expect "/wp-admin/ blocked"     "$(code -H 'Host: someblog.example' "$HTTP/wp-admin/")" 000
expect "/.env blocked"          "$(code -H 'Host: someblog.example' "$HTTP/.env")" 000

echo "caching + compression (blog traffic)"
expect_match "first hit is a MISS" "$(hdr -H 'Host: someblog.example' "$HTTP/cache-me")" "Blot-Cache: MISS"
expect_match "second hit is a HIT" "$(hdr -H 'Host: someblog.example' "$HTTP/cache-me")" "Blot-Cache: HIT"
expect_match "gzip negotiated"     "$(hdr -H 'Host: someblog.example' -H 'Accept-Encoding: gzip' "$HTTP/compress-me")" "Content-Encoding: gzip"

echo "upstream 503 (Node cannot reach Redis) passes through"
expect "503 status preserved" \
  "$(code -H 'Host: someblog.example' "$HTTP/unavailable")" 503
expect_match "Retry-After preserved" \
  "$(hdr -H 'Host: someblog.example' "$HTTP/unavailable")" "Retry-After: 60"
expect_match "Node's body, not the offline page" \
  "$(curl -sk -m 10 -H 'Host: someblog.example' "$HTTP/unavailable")" "temporarily unavailable"

echo "upstream failure surfaces an error, not a hang"
expect "500 from upstream is passed through or replaced" \
  "$([ "$(code -H 'Host: someblog.example' "$HTTP/boom")" != "000" ] && echo ok || echo timeout)" ok

exit $fail
