#!/bin/bash
#
# The deploy's own reading of a stored certificate (stored_cert_fps in
# proxy/deploy/common.sh) against exactly what lua-resty-auto-ssl wrote to
# Redis. auto-ssl stores JSON through lua-cjson, which escapes every / as \/,
# and base64 contains /, so a reader that only turns \n into newlines cannot
# parse the PEM. Run by the cert-issuance job in
# .github/workflows/integration.yml, after a certificate for $TEST_DOMAIN has
# been issued by Pebble.
#
# Environment: HOSTIP, TEST_DOMAIN, and optionally REDIS_CONTAINER (default
# redis, which shares the host network, so 127.0.0.1 reaches it).
set -eu

: "${HOSTIP:?}" "${TEST_DOMAIN:?}"
REDIS=${REDIS_CONTAINER:-redis}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# redis-cli is in the Redis container, not on the runner
redis-cli() { docker exec -i "$REDIS" redis-cli "$@"; }

# The real redis_cli and stored_cert_fps, as the deploy scripts run them
REDIS_HOST=127.0.0.1
eval "$(sed -n '/^redis_cli()/,/^}/p;/^stored_cert_fps()/,/^}/p' "$HERE/../deploy/common.sh")"

stored=$(redis-cli --raw get "ssl:$TEST_DOMAIN:latest")
case "$stored" in *'\/'*) ;; *) echo "FAIL: the stored certificate has no escaped / ; this check would prove nothing" >&2; exit 1 ;; esac

served=$(echo | timeout 15 openssl s_client -connect "$HOSTIP:443" -servername "$TEST_DOMAIN" 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2)
[ -n "$served" ] || { echo "FAIL: no certificate served for $TEST_DOMAIN" >&2; exit 1; }

got=$(printf '%s\n' "$TEST_DOMAIN" | stored_cert_fps)
echo "served: $served"
echo "stored: $got"
[ "$got" = "$TEST_DOMAIN $served" ] \
  || { echo "FAIL: stored_cert_fps did not give the fingerprint of the certificate served" >&2; exit 1; }
echo "ok: stored_cert_fps reads auto-ssl's stored certificate and matches what is served"
