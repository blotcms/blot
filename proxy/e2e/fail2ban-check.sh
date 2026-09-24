#!/usr/bin/env bash
# Sends requests through the built proxy image that should trigger each
# fail2ban filter in config/openresty/fail2ban/filter.d/, then runs
# fail2ban-regex against the container's access.log - exactly as host
# fail2ban does per config/openresty/fail2ban/jail.local - and asserts:
#
#   1. each filter matches exactly the requests that should have triggered
#      it, no more and no fewer;
#   2. the <HOST> fail2ban-regex extracts from those matches is the real
#      client IP - that's what fail2ban actually bans, so matching the
#      right lines is only half the story; and
#   3. an attacker-supplied X-Forwarded-For or CF-Connecting-IP can't change
#      what gets banned (either by getting an innocent IP banned, or
#      dodging a ban itself); and
#   4. every filter in config/openresty/fail2ban/filter.d/ has a traffic
#      case here, and vice versa - a filter added later without updating
#      this script would otherwise be silently skipped.
#
#   PROXY_HTTP   http base URL (default http://127.0.0.1)
#   ACCESS_LOG   path to the container's access.log on the runner (required)
#   HOSTIP       the runner's routable IP that PROXY_HTTP targets (required) -
#                the independent expectation for "what is the real client
#                IP", so a canary read back from the log that happens to
#                match some other wrong address (e.g. a gateway) can't pass
#                trivially by comparing the log only to itself
#
# Requires `fail2ban-regex` on PATH (apt install fail2ban) and the proxy +
# stub-upstream containers already running against it, on --network host
# (as production runs them - see proxy/deploy/common.sh), as
# .github/workflows/proxy-fail2ban.yml sets up. Host networking matters
# here specifically: with a published/bridged port, $remote_addr would be
# the docker bridge gateway for every request, and the IP-extraction checks
# below would be trivially "correct" without proving anything about what
# host fail2ban will actually see.
set -u

HTTP="${PROXY_HTTP:-http://127.0.0.1}"
ACCESS_LOG="${ACCESS_LOG:?ACCESS_LOG must be set}"
HOSTIP="${HOSTIP:?HOSTIP must be set}"
FILTER_DIR="config/openresty/fail2ban/filter.d"
SPOOFED_XFF_IP="203.0.113.9"
SPOOFED_CF_IP="203.0.113.10"
fail=0

# The statuses this script must have a traffic case for, derived from the
# filter files themselves (nginx-<status>.conf) rather than hard-coded, so a
# filter added later without a matching traffic case fails loudly instead of
# being silently skipped.
FILTER_STATUSES=()
for f in "$FILTER_DIR"/nginx-*.conf; do
  base="$(basename "$f")"
  FILTER_STATUSES+=("${base#nginx-}")
done
FILTER_STATUSES=("${FILTER_STATUSES[@]%.conf}")

code() { curl -sk -o /dev/null -m 10 -w '%{http_code}' "$@"; }

# Repeats a request until it gets the expected status. nginx-403 and
# nginx-444 traffic (below) shares a single limit_req zone (zone=bots,
# 1r/s, no burst), so a request fired too soon after another can be
# rejected with 503 instead of the status we're aiming for; retrying with a
# backoff keeps the count of requests-that-produced-status-X exact without
# hand-tuning sleeps.
send_until() {
  local expect="$1"; shift
  local got=""
  for _ in $(seq 1 15); do
    got="$(code "$@")"
    [ "$got" = "$expect" ] && return 0
    sleep 1.2
  done
  echo "  never observed $expect for: $* (last got $got)" >&2
  return 1
}

declare -A expected

echo "== generating traffic =="

echo "-- canary request, to learn what the real client IP looks like in the log"
send_until 403 -H 'Host: someblog.example' "$HTTP/probe-1.php" || fail=1
sleep 1
REAL_IP="$(grep 'probe-1\.php' "$ACCESS_LOG" | tail -n1 | grep -oP 'ip=\K[0-9a-fA-F:.]+')"
if [ -z "$REAL_IP" ]; then
  echo "FAIL - could not read the client IP back out of $ACCESS_LOG" >&2
  exit 1
fi
echo "  observed real client IP: $REAL_IP"
# Check that against an expectation independent of the log itself: traffic
# sent to the runner's own routable IP (HOSTIP) arrives from that address,
# so if the log recorded something else for every request (e.g. a gateway),
# that's a real bug this must catch, not something that gets to pass by
# only ever comparing the log against itself.
if [ "$REAL_IP" != "$HOSTIP" ]; then
  echo "FAIL - the log's client IP ($REAL_IP) does not match HOSTIP ($HOSTIP); \$remote_addr is not the real peer address" >&2
  exit 1
fi

echo "-- nginx-403 (blocked file extension)"
n403=4
for i in 2 3 4; do
  send_until 403 -H 'Host: someblog.example' "$HTTP/probe-$i.php" || fail=1
done
expected[403]=$n403

echo "-- nginx-444 (deliberately-malicious paths, connection closed - curl reports 000)"
paths444=("/.git/config" "/.env" "/wp-admin/" "/.aws/credentials")
for p in "${paths444[@]}"; do
  send_until 000 -H 'Host: someblog.example' "$HTTP$p" || fail=1
done
expected[444]=${#paths444[@]}

echo "-- nginx-403 again, this time with a spoofed X-Forwarded-For"
# nginx never reads X-Forwarded-For here at all (real_ip_header is
# CF-Connecting-IP, below) - so $remote_addr, and therefore what fail2ban
# bans, must still be REAL_IP.
send_until 403 -H 'Host: someblog.example' -H "X-Forwarded-For: $SPOOFED_XFF_IP" "$HTTP/probe-xff.php" || fail=1
n403=$((n403 + 1))

echo "-- nginx-403 again, this time with a spoofed CF-Connecting-IP"
# This is the header config/openresty/conf/cloudflare-real-ip.conf actually
# trusts (real_ip_header CF-Connecting-IP) - but only when the *immediate*
# TCP peer is one of Cloudflare's own edge ranges (set_real_ip_from). This
# request comes directly from the runner, not from one of those ranges, so
# nginx must ignore the header and $remote_addr must still be REAL_IP.
send_until 403 -H 'Host: someblog.example' -H "CF-Connecting-IP: $SPOOFED_CF_IP" "$HTTP/probe-cf.php" || fail=1
n403=$((n403 + 1))

expected[403]=$n403

echo "-- nginx-404 (upstream's own 404, passed through)"
n404=5
for i in $(seq 1 "$n404"); do
  send_until 404 -H 'Host: someblog.example' "$HTTP/notfound-$i" || fail=1
done
expected[404]=$n404

echo "-- nginx-429 (burst past zone=general/hostlimit)"
# The exact number of 429s a flood produces depends on timing, so count what
# the proxy itself rejected and use that as the expected count.
burst_codes="$(mktemp)"
seq 1 150 | xargs -P 40 -I{} curl -sk -o /dev/null -m 10 -w '%{http_code}\n' \
  -H 'Host: someblog.example' "$HTTP/burst-{}" > "$burst_codes"
n429=$(grep -c '^429$' "$burst_codes")
rm -f "$burst_codes"
if [ "$n429" -lt 1 ]; then
  echo "  FAIL - the burst never triggered a single 429 (got 0)" >&2
  fail=1
fi
expected[429]=$n429

echo "expected counts: 403=${expected[403]} 404=${expected[404]} 429=${expected[429]} 444=${expected[444]}"

echo "== filter coverage ($FILTER_DIR/*.conf vs traffic cases in this script) =="
for status in "${FILTER_STATUSES[@]}"; do
  if [ -z "${expected[$status]+x}" ]; then
    echo "FAIL - $FILTER_DIR/nginx-$status.conf has no traffic case in this script; add one above that sends request(s) producing a $status and sets expected[$status]" >&2
    fail=1
  fi
done
for status in "${!expected[@]}"; do
  known=0
  for s in "${FILTER_STATUSES[@]}"; do [ "$s" = "$status" ] && known=1 && break; done
  if [ "$known" = 0 ]; then
    echo "FAIL - this script has a traffic case for '$status' but no $FILTER_DIR/nginx-$status.conf filter exists" >&2
    fail=1
  fi
done

# Give the access log a moment to land (buffered file I/O) before reading it.
sleep 1

echo "== spoofed IPs never reached the log =="
for spoofed in "$SPOOFED_XFF_IP" "$SPOOFED_CF_IP"; do
  if grep -q "$spoofed" "$ACCESS_LOG"; then
    echo "FAIL - the spoofed IP ($spoofed) appears in $ACCESS_LOG; an attacker could get arbitrary IPs banned or dodge a ban" >&2
    fail=1
  else
    echo "  ok  - $spoofed never appears in the log"
  fi
done

echo "== fail2ban-regex =="
for status in "${FILTER_STATUSES[@]}"; do
  if [ -z "${expected[$status]+x}" ]; then
    continue  # already reported by the coverage check above
  fi
  filter="$FILTER_DIR/nginx-$status.conf"
  # -v also prints, per matched failregex, the <HOST> it extracted (indented
  # under the regex, e.g. "|      1.2.3.4  Wed Sep 24 ..."), distinct from
  # the differently-indented date-template-hits summary below it.
  out="$(fail2ban-regex "$ACCESS_LOG" "$filter" -v 2>&1)"
  matched="$(printf '%s\n' "$out" | grep -oE '[0-9]+ matched' | grep -oE '^[0-9]+')"
  ips="$(printf '%s\n' "$out" | grep -oP '^\|\s{4,}\K[0-9a-fA-F:.]+(?=\s)' | sort -u)"
  want="${expected[$status]}"
  echo "-- nginx-$status.conf: matched=${matched:-<none>} want=$want extracted_ip(s)=[$(printf '%s' "$ips" | tr '\n' ' ')]"
  if [ "$matched" != "$want" ]; then
    echo "FAIL - nginx-$status.conf matched '$matched' lines of $ACCESS_LOG, expected $want" >&2
    printf '%s\n' "$out" >&2
    fail=1
  fi
  if [ "$ips" != "$REAL_IP" ]; then
    echo "FAIL - nginx-$status.conf extracted IP(s) [$ips], want only the real client IP $REAL_IP - fail2ban would ban the wrong address" >&2
    fail=1
  fi
done

exit $fail
