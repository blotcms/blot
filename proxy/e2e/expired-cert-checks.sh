#!/bin/bash
#
# What custom-domain HTTPS does when the certificate stored in Redis has
# expired. lua-resty-auto-ssl serves whatever is stored without looking at the
# expiry, so the proxy treats an expired certificate as missing (see
# get_cert in proxy/config/init.conf). Run by the cert-issuance job in
# .github/workflows/integration.yml, after a certificate for $TEST_DOMAIN has
# been issued, against:
#
#   - a proxy container, started with PROXY_AUTO_SSL_CACHE_TTL set (seconds)
#   - the Redis container the proxy reads certificates from
#
# Environment: HOSTIP, TEST_DOMAIN, CA_BUNDLE (the Pebble root + intermediate),
# CACHE_TTL, and optionally PROXY_CONTAINER / REDIS_CONTAINER if they are not
# named proxy / redis.
# No pipefail: `docker logs ... | grep -q` would fail on the SIGPIPE grep
# sends when it stops reading at the first match.
set -eu

: "${HOSTIP:?}" "${TEST_DOMAIN:?}" "${CA_BUNDLE:?}" "${CACHE_TTL:?}"
PROXY=${PROXY_CONTAINER:-proxy}
REDIS=${REDIS_CONTAINER:-redis}
ORPHAN=orphan-expired.example

# Long enough for anything the proxy cached to have expired
PAST_TTL=$((CACHE_TTL + 2))

redis() { docker exec "$REDIS" redis-cli "$@"; }

workdir=$(mktemp -d)
cleanup() { redis del "ssl:$ORPHAN:latest" "domain:$ORPHAN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

served_subject() {
  echo | timeout 15 openssl s_client -connect "$HOSTIP:443" -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject
}

# Stores a certificate in auto-ssl's JSON format, self-signed for $1, which
# expired a day ago
write_expired_cert() {
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
    -subj "/O=expired-in-redis/CN=$1" \
    -keyout "$workdir/$1.key" -out "$workdir/$1.pem" 2>/dev/null
  node -e '
    const fs = require("fs");
    const [pem, key] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
    process.stdout.write(JSON.stringify({
      fullchain_pem: pem,
      privkey_pem: key,
      expiry: Math.floor(Date.now() / 1000) - 86400,
    }));
  ' "$workdir/$1.pem" "$workdir/$1.key" > "$workdir/$1.json"
  docker exec -i "$REDIS" redis-cli -x set "ssl:$1:latest" < "$workdir/$1.json" >/dev/null
}

echo "=== A listed domain with an expired certificate is issued a new one ==="
write_expired_cert "$TEST_DOMAIN"
sleep "$PAST_TTL"

# Issuing shells out to dehydrated, so allow longer than the other checks. The
# certificate must verify against the Pebble CA, which the expired
# self-signed one does not.
curl -sS -o /dev/null --max-time 60 --cacert "$CA_BUNDLE" \
  --resolve "$TEST_DOMAIN:443:$HOSTIP" "https://$TEST_DOMAIN/"
docker logs "$PROXY" 2>&1 | grep -q "certificate for $TEST_DOMAIN expired at"

expiry=$(redis get "ssl:$TEST_DOMAIN:latest" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () =>
    console.log(JSON.parse(s).expiry));')
echo "$TEST_DOMAIN now expires at $expiry"
[ "$expiry" -gt "$(date +%s)" ]

echo "=== The same domain expiring again within the hour is not issued another ==="
# One issuance attempt per domain per hour per container, so a listed domain
# that cannot be issued does not start an ACME order on every handshake
redis copy "ssl:$TEST_DOMAIN:latest" "ssl-test-backup" replace >/dev/null
write_expired_cert "$TEST_DOMAIN"
sleep "$PAST_TTL"
subject=$(served_subject "$TEST_DOMAIN")
echo "$TEST_DOMAIN: $subject"
echo "$subject" | grep -q blot-proxy-placeholder
redis copy "ssl-test-backup" "ssl:$TEST_DOMAIN:latest" replace >/dev/null
redis del "ssl-test-backup" >/dev/null

echo "=== An unlisted domain with an expired certificate gets the fallback ==="
write_expired_cert "$ORPHAN"
subject=$(served_subject "$ORPHAN")
echo "$ORPHAN: $subject"
echo "$subject" | grep -q blot-proxy-placeholder
if docker logs "$PROXY" 2>&1 | grep -q "issuing new certificate for $ORPHAN"; then
  echo "FAIL: proxy started an ACME order for $ORPHAN" >&2
  exit 1
fi

echo "=== An unlisted domain's expired certificate does not use up the hour ==="
# Listing the domain afterwards must still get an issuance attempt. (The test
# ACME server cannot validate this name, so no certificate comes back: what
# matters is that an order was started.)
redis set "domain:$ORPHAN" 1 >/dev/null
sleep "$PAST_TTL"
served_subject "$ORPHAN" >/dev/null || true
if ! docker logs "$PROXY" 2>&1 | grep -q "issuing new certificate for $ORPHAN"; then
  echo "FAIL: proxy did not try to issue a certificate for $ORPHAN once it was listed" >&2
  exit 1
fi

echo "all expired certificate checks passed"
