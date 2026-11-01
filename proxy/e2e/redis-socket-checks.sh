#!/bin/bash
#
# The proxy with PROXY_REDIS_HOST=unix:/run/blot/redis/redis.sock: Redis on
# the same host, reached over a Unix socket (#2261). Run by the cert-issuance
# job in .github/workflows/integration.yml, after the other Redis checks,
# against the Pebble ACME server and upstream stub that job started. It
# replaces that job's proxy and TCP Redis with its own pair, sharing a
# socket directory:
#
#   - Redis 6.2 with port 0 (no TCP at all), listening on the socket, 0777 in
#     a 0755 directory owned by redis, as on the host. The proxy's workers
#     are not that user
#   - a proxy container (PROXY_AUTO_SSL_CACHE_TTL set, as in
#     redis-outage-checks.sh) with that directory mounted at /run/blot/redis
#
# Checks that the wildcard certificate and a certificate issued for a custom
# domain both go through the socket, that a restart of Redis is survived, and
# that a missing socket is handled like an unreachable TCP Redis: certificates
# already read keep being served, an unlisted domain gets the fallback
# certificate quickly with no ACME order, and the proxy recovers.
#
# Environment: HOSTIP, TEST_DOMAIN, CA_BUNDLE (the Pebble root + intermediate),
# and optionally PROXY_IMAGE (default blot-proxy:acme) and MINICA (the CA of
# Pebble's ACME endpoint, default pebble.minica.pem in the working directory).
# No pipefail: `docker logs ... | grep -q` would fail on the SIGPIPE grep
# sends when it stops reading at the first match.
set -eu

: "${HOSTIP:?}" "${TEST_DOMAIN:?}" "${CA_BUNDLE:?}"
IMAGE=${PROXY_IMAGE:-blot-proxy:acme}
MINICA=${MINICA:-$PWD/pebble.minica.pem}
PROXY=proxy-sock
REDIS=redis-sock
VOLUME=blot-acme-socket
# The containers and volume are left for the job's logs and tear-down steps
SOCKET=/run/blot/redis/redis.sock
CACHE_TTL=5
PAST_TTL=$((CACHE_TTL + 2))

# Seconds between the proxy's reads of Redis (INTERVAL in wildcard_cert.lua)
# plus slack
WAIT=30

WORK=$(mktemp -d)
SOCKDIR=$WORK/redis
mkdir "$SOCKDIR"

redis() { docker exec "$REDIS" redis-cli -s "$SOCKET" "$@"; }

wait_for_redis() {
  for _ in $(seq 1 30); do
    [ "$(redis ping 2>/dev/null || true)" = PONG ] && return 0
    sleep 1
  done
  echo "redis did not come back" >&2
  return 1
}

make_cert() { # make_cert <name>: $WORK/<name>.pem and .key, CN=<name>
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -days 2 -subj "/CN=$1" -addext "subjectAltName=DNS:localhost,DNS:*.localhost" \
    -keyout "$WORK/$1.key" -out "$WORK/$1.pem" 2>/dev/null
}

put_cert() { # put_cert <name>: the wildcard certificate
  docker exec -i "$REDIS" redis-cli -s "$SOCKET" -x set blot:openresty:ssl:key < "$WORK/$1.key" >/dev/null
  docker exec -i "$REDIS" redis-cli -s "$SOCKET" -x set blot:openresty:ssl:pem < "$WORK/$1.pem" >/dev/null
}

served_subject() { # served_subject <sni>
  echo | timeout 15 openssl s_client -connect "$HOSTIP:443" -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null || true
}

wait_for() { # wait_for <CN> <sni>
  local i subject
  for i in $(seq 1 "$WAIT"); do
    subject=$(served_subject "$2")
    case "$subject" in *"$1"*) echo "  ok  - $2 serves $1 (after ${i}s)"; return 0 ;; esac
    sleep 1
  done
  echo "  FAIL - $2 does not serve $1 (got '$subject')" >&2
  docker logs --tail 40 "$PROXY" >&2 || true
  exit 1
}

# Fails unless $TEST_DOMAIN is served with a certificate that verifies
# against the Pebble CA, i.e. the one issued earlier, not the fallback.
expect_issued_cert() {
  curl -sS -o /dev/null --max-time 10 --cacert "$CA_BUNDLE" \
    --resolve "$TEST_DOMAIN:443:$HOSTIP" "https://$TEST_DOMAIN/"
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

# resty.redis raises an error, not nil, err, when given a port with a unix:
# host. That would show up as a Lua error in the log, not a failed connect.
expect_no_lua_errors() {
  if docker logs "$PROXY" 2>&1 | grep -E "bad argument|lua entry thread aborted|runtime error"; then
    echo "FAIL: Lua errors in the proxy log" >&2
    exit 1
  fi
}

echo "=== Setup: Redis on a socket only, the proxy mounting it ==="

# The TCP Redis and proxy of the earlier checks make way. Nothing else
# listens on 6379 now, so anything that works below worked over the socket.
docker rm -f proxy >/dev/null 2>&1 || true
docker stop redis >/dev/null 2>&1 || true

docker run --rm --user root -v "$SOCKDIR:/s" redis:6.2.12-alpine \
  sh -c 'chown redis:redis /s && chmod 755 /s'
docker run -d --name "$REDIS" -v "$SOCKDIR:/run/blot/redis" redis:6.2.12-alpine \
  redis-server --port 0 --unixsocket "$SOCKET" --unixsocketperm 777 >/dev/null
wait_for_redis
redis set "domain:$TEST_DOMAIN" 1 >/dev/null

make_cert wildcard-a
make_cert wildcard-b
make_cert wildcard-c
put_cert wildcard-a

docker volume create "$VOLUME" >/dev/null
docker run -d --name "$PROXY" --network host --cap-add SYS_NICE \
  -e BLOT_HOST=localhost \
  -e PROXY_UNIT_MAIN=127.0.0.1:8090 -e PROXY_UNIT_WORKER=127.0.0.1:8089 \
  -e PROXY_PEER_MAIN=127.0.0.1:8088 -e PROXY_PEER_WORKER=127.0.0.1:8088 \
  -e PROXY_REDIS_HOST="unix:$SOCKET" \
  -e PROXY_ACME_CA=https://127.0.0.1:14000/dir \
  -e ACME_CA_CERT=/pebble-ca.pem \
  -e PROXY_AUTO_SSL_CACHE_TTL="$CACHE_TTL" \
  -v "$MINICA:/pebble-ca.pem:ro" \
  -v "$VOLUME:/etc/resty-auto-ssl" \
  -v "$SOCKDIR:/run/blot/redis" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PROXY")" = healthy ] && break
  sleep 2
done

echo "=== The wildcard certificate is read from Redis over the socket ==="
wait_for wildcard-a localhost
wait_for wildcard-a anything.localhost

echo "=== A custom domain is issued a certificate, stored over the socket ==="
ok=""
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' \
    --resolve "$TEST_DOMAIN:443:$HOSTIP" "https://$TEST_DOMAIN/" || true)
  echo "attempt $i -> $code"
  if [ "$code" = 200 ]; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] || { docker logs "$PROXY" >&2; exit 1; }
expect_issued_cert
[ "$(redis exists "ssl:$TEST_DOMAIN:latest")" = 1 ]

echo "=== Redis restarts: the proxy reconnects ==="
docker restart "$REDIS" >/dev/null
wait_for_redis
[ "$(redis exists "ssl:$TEST_DOMAIN:latest")" = 1 ]
put_cert wildcard-b
wait_for wildcard-b localhost
# past the certificate cache, so it is read from Redis again
sleep "$PAST_TTL"
expect_issued_cert

echo "=== The socket is gone (Redis stopped): what was read keeps being served ==="
docker stop "$REDIS" >/dev/null
[ ! -S "$SOCKDIR/redis.sock" ]
sleep "$PAST_TTL"
expect_issued_cert
wait_for wildcard-b localhost
expect_fallback_fast unlisted-socket.example
# and again, now that the failed connect is remembered (the 5s backoff)
expect_fallback_fast unlisted-socket-2.example

echo "=== The socket is back: reads resume ==="
docker start "$REDIS" >/dev/null
wait_for_redis
put_cert wildcard-c
wait_for wildcard-c localhost
sleep "$PAST_TTL"
expect_issued_cert

expect_no_lua_errors
echo "ok"
