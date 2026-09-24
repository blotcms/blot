#!/usr/bin/env bash
# Sends requests through the built proxy image that should trigger each
# fail2ban filter in config/openresty/fail2ban/filter.d/, then runs
# fail2ban-regex against the container's access.log - exactly as host
# fail2ban does per config/openresty/fail2ban/jail.local - and asserts each
# filter matches exactly the requests that should have triggered it, no more
# and no fewer.
#
#   PROXY_HTTP   http base URL (default http://127.0.0.1:8080)
#   ACCESS_LOG   path to the container's access.log on the runner (required)
#
# Requires `fail2ban-regex` on PATH (apt install fail2ban) and the proxy +
# stub-upstream containers already running against it, as
# .github/workflows/proxy-fail2ban.yml sets up.
set -u

HTTP="${PROXY_HTTP:-http://127.0.0.1:8080}"
ACCESS_LOG="${ACCESS_LOG:?ACCESS_LOG must be set}"
FILTER_DIR="config/openresty/fail2ban/filter.d"
fail=0

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

echo "-- nginx-403 (blocked file extension)"
n403=4
for i in $(seq 1 "$n403"); do
  send_until 403 -H 'Host: someblog.example' "$HTTP/probe-$i.php" || fail=1
done
expected[403]=$n403

echo "-- nginx-444 (deliberately-malicious paths, connection closed - curl reports 000)"
paths444=("/.git/config" "/.env" "/wp-admin/setup.php" "/.aws/credentials")
for p in "${paths444[@]}"; do
  send_until 000 -H 'Host: someblog.example' "$HTTP$p" || fail=1
done
expected[444]=${#paths444[@]}

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

# Give the access log a moment to land (buffered file I/O) before reading it.
sleep 1

echo "== fail2ban-regex =="
for status in 403 404 429 444; do
  filter="$FILTER_DIR/nginx-$status.conf"
  out="$(fail2ban-regex "$ACCESS_LOG" "$filter" 2>&1)"
  matched="$(printf '%s\n' "$out" | grep -oE '[0-9]+ matched' | grep -oE '^[0-9]+')"
  want="${expected[$status]}"
  echo "-- nginx-$status.conf: matched=${matched:-<none>} want=$want"
  if [ "$matched" != "$want" ]; then
    echo "FAIL - nginx-$status.conf matched '$matched' lines of $ACCESS_LOG, expected $want" >&2
    printf '%s\n' "$out" >&2
    fail=1
  fi
done

exit $fail
