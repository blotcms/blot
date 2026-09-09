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

echo "hardening (blog traffic)"
expect "/.git/config blocked"   "$(code -H 'Host: someblog.example' "$HTTP/.git/config")" 404
expect "/wp-admin/ blocked"     "$(code -H 'Host: someblog.example' "$HTTP/wp-admin/")" 404
expect "/wp-content/x blocked"  "$(code -H 'Host: someblog.example' "$HTTP/wp-content/x")" 404

echo "caching + compression (blog traffic)"
expect_match "first hit is a MISS" "$(hdr -H 'Host: someblog.example' "$HTTP/cache-me")" "Blot-Cache: MISS"
expect_match "second hit is a HIT" "$(hdr -H 'Host: someblog.example' "$HTTP/cache-me")" "Blot-Cache: HIT"
expect_match "gzip negotiated"     "$(hdr -H 'Host: someblog.example' -H 'Accept-Encoding: gzip' "$HTTP/compress-me")" "Content-Encoding: gzip"

echo "upstream failure surfaces an error, not a hang"
expect "500 from upstream is passed through or replaced" \
  "$([ "$(code -H 'Host: someblog.example' "$HTTP/boom")" != "000" ] && echo ok || echo timeout)" ok

exit $fail
