#!/bin/bash
#
# What custom-domain HTTPS does when Redis, which holds the certificates, is
# stopped, comes back with a different certificate, or refuses writes
# (READONLY, NOREPLICAS). Run by the cert-issuance job in
# .github/workflows/integration.yml, after a certificate for $TEST_DOMAIN has
# been issued, against:
#
#   - a proxy container, started with PROXY_AUTO_SSL_CACHE_TTL set (seconds;
#     it stands in for auto-ssl's hour)
#   - the Redis 6.2 container the proxy reads certificates from
#
# Environment: HOSTIP, TEST_DOMAIN, CA_BUNDLE (the Pebble root + intermediate),
# CACHE_TTL (the proxy's PROXY_AUTO_SSL_CACHE_TTL), and optionally
# PROXY_CONTAINER / REDIS_CONTAINER if they are not named proxy / redis.
# No pipefail: `docker logs ... | grep -q` would fail on the SIGPIPE grep
# sends when it stops reading at the first match.
set -eu

: "${HOSTIP:?}" "${TEST_DOMAIN:?}" "${CA_BUNDLE:?}" "${CACHE_TTL:?}"
PROXY=${PROXY_CONTAINER:-proxy}
REDIS=${REDIS_CONTAINER:-redis}

# Long enough for anything the proxy cached to have expired
PAST_TTL=$((CACHE_TTL + 2))

redis() { docker exec "$REDIS" redis-cli "$@"; }

restore_redis() {
  docker start "$REDIS" >/dev/null 2>&1 || true
  redis replicaof no one >/dev/null 2>&1 || true
  redis config set min-replicas-to-write 0 >/dev/null 2>&1 || true
}
trap restore_redis EXIT

wait_for_redis() {
  for _ in $(seq 1 30); do
    [ "$(redis ping 2>/dev/null)" = "PONG" ] && return 0
    sleep 1
  done
  echo "redis did not come back" >&2
  return 1
}

# Fails unless $TEST_DOMAIN is served with a certificate that verifies
# against the Pebble CA, i.e. the one issued earlier, not the fallback.
expect_issued_cert() {
  curl -sS -o /dev/null --max-time 10 --cacert "$CA_BUNDLE" \
    --resolve "$TEST_DOMAIN:443:$HOSTIP" "https://$TEST_DOMAIN/"
}

served_subject() {
  echo | openssl s_client -connect "$HOSTIP:443" -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject
}

# A domain the proxy has no certificate for must get the fallback
# (placeholder) certificate quickly, without an ACME order.
expect_fallback_fast() {
  local domain=$1 start elapsed subject
  start=$(date +%s)
  subject=$(served_subject "$domain")
  elapsed=$(( $(date +%s) - start ))
  echo "$domain: $subject (${elapsed}s)"
  echo "$subject" | grep -q blot-proxy-placeholder
  [ "$elapsed" -lt 10 ]
  if docker logs "$PROXY" 2>&1 | grep -q "issuing new certificate for $domain"; then
    echo "FAIL: proxy started an ACME order for $domain" >&2
    exit 1
  fi
}

echo "=== Redis stopped: a recently served domain keeps its certificate ==="

# The proxy reads the certificate from Redis and keeps a stale copy
sleep "$PAST_TTL"
expect_issued_cert

redis save >/dev/null
docker stop "$REDIS" >/dev/null

# Past the auto-ssl cache, twice: each time the proxy fails to read Redis and
# falls back to its stale copy
for round in 1 2; do
  sleep "$PAST_TTL"
  expect_issued_cert
  echo "served $TEST_DOMAIN from the stale copy (round $round)"
done
docker logs "$PROXY" 2>&1 | grep -q "cannot read certificate for $TEST_DOMAIN from redis"

# A reload (as renew-wildcard-ssl.sh does) keeps the shared dicts
docker exec "$PROXY" /usr/local/openresty/bin/openresty -s reload
sleep "$PAST_TTL"
expect_issued_cert
echo "served $TEST_DOMAIN from the stale copy after a reload"

echo "=== Redis stopped: a domain without a certificate gets the fallback ==="
expect_fallback_fast unlisted.example

echo "=== Redis back with a newer certificate: Redis wins over the stale copy ==="
docker start "$REDIS" >/dev/null
wait_for_redis
[ "$(redis exists "ssl:$TEST_DOMAIN:latest")" = "1" ]

workdir=$(mktemp -d)
openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
  -subj "/O=newer-in-redis/CN=$TEST_DOMAIN" \
  -keyout "$workdir/newer.key" -out "$workdir/newer.pem" 2>/dev/null
node -e '
  const fs = require("fs");
  const [pem, key] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
  process.stdout.write(JSON.stringify({
    fullchain_pem: pem,
    privkey_pem: key,
    expiry: Math.floor(Date.now() / 1000) + 30 * 86400,
  }));
' "$workdir/newer.pem" "$workdir/newer.key" > "$workdir/newer.json"

redis copy "ssl:$TEST_DOMAIN:latest" "ssl-test-backup" replace >/dev/null
docker exec -i "$REDIS" redis-cli -x set "ssl:$TEST_DOMAIN:latest" < "$workdir/newer.json" >/dev/null

# The stale copy was last served with a short cache, so the next handshake
# past it reads Redis again
sleep "$PAST_TTL"
subject=$(served_subject "$TEST_DOMAIN")
echo "$TEST_DOMAIN: $subject"
echo "$subject" | grep -q newer-in-redis

redis copy "ssl-test-backup" "ssl:$TEST_DOMAIN:latest" replace >/dev/null
redis del "ssl-test-backup" >/dev/null
sleep "$PAST_TTL"
expect_issued_cert
echo "back on the issued certificate once Redis has it again"

echo "=== READONLY: certificates are still read, issuance fails fast ==="
redis set domain:readonly.example 1 >/dev/null
# A replica of a master that does not exist: it keeps its data, serves reads
# and refuses writes
redis replicaof 127.0.0.1 1 >/dev/null
reply=$(redis set readonly-probe 1 2>&1 || true)
echo "SET on the replica: $reply"
echo "$reply" | grep -q READONLY

sleep "$PAST_TTL"
expect_issued_cert
expect_fallback_fast readonly.example
docker logs "$PROXY" 2>&1 | grep "failed to obtain lock" | grep -q READONLY

redis replicaof no one >/dev/null

echo "=== NOREPLICAS: certificates are still read, issuance fails fast ==="
redis set domain:noreplicas.example 1 >/dev/null
# auto-ssl writes with plain SET (no EVAL, to which Redis 6.2 does not apply
# min-replicas-to-write), so every write is refused
redis config set min-replicas-to-write 99 >/dev/null
reply=$(redis set noreplicas-probe 1 2>&1 || true)
echo "SET with min-replicas-to-write 99: $reply"
echo "$reply" | grep -q NOREPLICAS

sleep "$PAST_TTL"
expect_issued_cert
expect_fallback_fast noreplicas.example
docker logs "$PROXY" 2>&1 | grep "failed to obtain lock" | grep -q NOREPLICAS

redis config set min-replicas-to-write 0 >/dev/null

echo "all Redis outage checks passed"
