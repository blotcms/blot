#!/usr/bin/env bash
#
# Drives cutover-from-baremetal.sh and blue-green.sh against fake docker,
# systemctl, curl and openssl, to check the order of operations and, above
# all, that every failure puts the previous proxy back. Needs no Docker and no
# root:  bash proxy/deploy/tests/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/.."
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export FAKE="$T/fake"
mkdir -p "$T/bin" "$T/certs" "$T/cache" "$T/logs" "$FAKE"
echo cert > "$T/certs/letsencrypt-domain.pem"; echo key > "$T/certs/letsencrypt-domain.key"
printf 'BLOT_HOST=blot.test\nPROXY_REDIS_HOST=10.0.0.5\n' > "$T/proxy.env"
echo "BLOT_REVERSE_PROXY_URLS='http://10.0.0.9:8077'" > "$T/secrets.env"
echo "docker exec blot-proxy-blue openresty -s reload" > "$T/renew.sh"

cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
R="$FAKE/running"; mkdir -p "$R"
name_arg() { while [ $# -gt 0 ]; do [ "$1" = --name ] && { echo "$2"; return; }; shift; done; }
case "$1" in
  image) exit 0 ;;
  pull) exit 0 ;;
  network) echo 172.17.0.1 ;;
  ps) if [[ "$*" == *" -a "* ]]; then ls "$FAKE/all" 2>/dev/null; else ls "$R"; fi; exit 0 ;;
  run)
    if [[ " $* " == *" -d "* ]]; then n=$(name_arg "$@"); touch "$R/$n" "$FAKE/all/$n" 2>/dev/null || { mkdir -p "$FAKE/all"; touch "$R/$n" "$FAKE/all/$n"; }; exit 0; fi
    if [[ "$*" == *"openresty -t"* ]]; then [ -z "${FAKE_VALIDATE_FAIL:-}" ] || { echo "nginx: [emerg] bad"; exit 1; }; exit 0; fi
    if [[ "$*" == *"access_log"* ]]; then [ -z "${FAKE_STDOUT_LOGS:-}" ]; exit; fi ;;
  create) n=$(name_arg "$@"); mkdir -p "$FAKE/all"; touch "$FAKE/all/$n" ;;
  start)
    n="$2"; [ "$n" != "${FAKE_START_FAILS:-}" ] || exit 1
    touch "$R/$n"; rm -f "$FAKE/stopped"
    if [[ "$n" == blot-proxy-* ]]; then
      if [ "$(cat "$FAKE/serving")" = baremetal ]; then rm -f "$R/$n"; else echo container > "$FAKE/serving"; fi
    fi ;;
  stop) n="${!#}"; rm -f "$R/$n"; touch "$FAKE/stopped"
    [ -n "$(ls "$R" | grep '^blot-proxy-[bg]')" ] || echo none > "$FAKE/serving" ;;
  rm) n="${!#}"; rm -f "$R/$n" "$FAKE/all/$n"
    [ -n "$(ls "$R" | grep '^blot-proxy-[bg]')" ] || { [ "$(cat "$FAKE/serving")" != container ] || echo none > "$FAKE/serving"; } ;;
  update|logs) ;;
  exec)
    n="$2"
    if [[ "$*" == *"--unix-socket"* ]]; then [ -e "$R/$n" ] && [ "$n" != "${FAKE_UNHEALTHY:-}" ]; exit; fi
    if [[ "$3" == node ]]; then [ -z "${FAKE_PURGE_FAIL:-}" ]; exit; fi ;;
esac
exit 0
F
cat > "$T/bin/curl" <<'F'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls"
args="$*"
if [[ "$args" == *"/health"* ]]; then printf 200; exit 0; fi
port=443; [[ "$args" =~ :443:127.0.0.1:([0-9]+) ]] && port="${BASH_REMATCH[1]}"
if [ "$port" = 18443 ]; then printf '%s' "${FAKE_REHEARSAL_CODE:-200}"; exit 0; fi
case "$(cat "$FAKE/serving")" in
  baremetal) printf 200 ;;
  container)
    if [ -n "${FAKE_CONTAINER_CODE:-}" ]; then printf '%s' "$FAKE_CONTAINER_CODE"
    elif [ -n "${FAKE_FAIL_AFTER_STOP:-}" ] && [ -e "$FAKE/stopped" ]; then printf 502
    else printf 200; fi ;;
  *) printf 000; exit 7 ;;
esac
F
cat > "$T/bin/systemctl" <<'F'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/calls"
case "$1" in
  is-active) [ -e "$FAKE/unit_active" ] ;;
  stop) rm -f "$FAKE/unit_active"; echo none > "$FAKE/serving" ;;
  start) touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving" ;;
  disable) touch "$FAKE/unit_disabled" ;;
esac
F
cat > "$T/bin/sudo" <<'F'
#!/usr/bin/env bash
shift; exec "$@"
F
cat > "$T/bin/openssl" <<'F'
#!/usr/bin/env bash
case "$1" in
  x509)
    if [[ "$*" == *-checkend* ]]; then [ -z "${FAKE_CERT_EXPIRING:-}" ]; exit; fi
    if [[ "$*" == *-pubkey* ]]; then echo pub; exit; fi
    if [[ "$*" == *-fingerprint* ]]; then
      if [[ "$*" == *" -in "* ]]; then echo fp=A
      elif [ "$(cat "$FAKE/sclient_port" 2>/dev/null)" = 443 ]; then echo "fp=${FAKE_SERVED_FP:-A}"   # only the live port
      else echo fp=A; fi; exit; fi ;;
  pkey) echo "${FAKE_KEY_PUB:-pub}" ;;
  sha256) sha256sum ;;
  s_client) [[ "$*" =~ :([0-9]+)\  ]] && echo "${BASH_REMATCH[1]}" > "$FAKE/sclient_port"; echo served ;;
esac
F
chmod +x "$T"/bin/*
export PATH="$T/bin:$PATH"

export PROXY_ENV_FILE="$T/proxy.env" PROXY_CACHE_DIR="$T/cache" PROXY_LOG_DIR="$T/logs" \
  PROXY_CERT_DIR="$T/certs" PROXY_NODE_ENV_FILE="$T/secrets.env" PROXY_RENEW_SCRIPT="$T/renew.sh" \
  PROXY_DEPLOY_SLEEP=true PROXY_HEALTH_TIMEOUT=1 TMUX=fake

pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { failed=$((failed + 1)); echo "  FAIL $*"; echo "----- calls"; sed 's/^/    /' "$FAKE/calls"; echo "----- output"; sed 's/^/    /' "$T/out"; }

# reset [baremetal|container]: fresh host state, `serving` says who owns :443
reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE/running" "$FAKE/all"; : > "$FAKE/calls"
  unset "${!FAKE_@}" 2>/dev/null; export FAKE="$T/fake"
  if [ "$1" = baremetal ]; then touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving"
  else touch "$FAKE/running/blot-proxy-blue" "$FAKE/all/blot-proxy-blue"; echo container > "$FAKE/serving"; fi
}
line() { grep -n -m1 -- "$1" "$FAKE/calls" | cut -d: -f1; }
called() { grep -q -- "$1" "$FAKE/calls"; }
before() { local a b; a=$(line "$1"); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
after_last() { local a b; a=$(grep -n -- "$1" "$FAKE/calls" | tail -1 | cut -d: -f1); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -gt "$b" ]; }

cutover() { bash "$DEPLOY/cutover-from-baremetal.sh" --yes --soak 10 "$@" img:1 >"$T/out" 2>&1; RC=$?; }
bluegreen() { bash "$DEPLOY/blue-green.sh" img:2 >"$T/out" 2>&1; RC=$?; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
serving() { [ "$(cat "$FAKE/serving")" = "$1" ]; }
mentions() { grep -q -- "$1" "$T/out"; }

echo "cutover-from-baremetal.sh"

reset baremetal; cutover --dry-run
check "dry run: rehearses, changes nothing" '[ $RC = 0 ] && called "run -d --name blot-proxy-rehearsal" && ! called "systemctl stop" && ! called "docker create" && serving baremetal'

reset baremetal; cutover
check "success: bare-metal stops before the container starts" '[ $RC = 0 ] && before "systemctl stop openresty" "docker start blot-proxy-blue"'
check "success: bare-metal is only disabled, and the container only made permanent, at the end" 'before "docker start blot-proxy-blue" "systemctl disable openresty" && before "systemctl disable" "docker update --restart unless-stopped" && serving container'
check "success: the container is created with restart policy no" 'called "docker create --restart no"'

reset baremetal; FAKE_CONTAINER_CODE=502 cutover
check "failed live check: rolls back to bare-metal, never disables it" '[ $RC != 0 ] && serving baremetal && after_last "systemctl start openresty" "systemctl stop openresty" && ! called "systemctl disable" && ! called "docker update"'
check "failed live check: removes the container" 'called "docker rm -f blot-proxy-blue"'

reset baremetal; FAKE_UNHEALTHY=blot-proxy-blue cutover
check "container never healthy: rolls back to bare-metal" '[ $RC != 0 ] && serving baremetal && ! called "systemctl disable"'

reset baremetal; FAKE_START_FAILS=blot-proxy-blue cutover
check "container fails to start: rolls back to bare-metal" '[ $RC != 0 ] && serving baremetal && called "systemctl start openresty"'

reset baremetal; FAKE_SERVED_FP=B cutover
check "wrong certificate served live: rolls back (placeholder cert)" '[ $RC != 0 ] && called "docker start blot-proxy-blue" && serving baremetal'

reset baremetal; FAKE_PURGE_FAIL=1 cutover
check "purge endpoint unreachable: refused before anything changes" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "purge"'

reset baremetal; FAKE_REHEARSAL_CODE=502 cutover
check "rehearsal differs from bare-metal: refused before the stop" '[ $RC != 0 ] && ! called "systemctl stop" && ! called "docker create" && mentions "rehearsal answers differ"'
check "rehearsal container is cleaned up on refusal" '! [ -e "$FAKE/running/blot-proxy-rehearsal" ]'

reset baremetal; FAKE_STDOUT_LOGS=1 cutover
check "image that logs to stdout: refused (fail2ban would go blind)" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "LOG_TO_STDOUT"'

reset baremetal; FAKE_VALIDATE_FAIL=1 cutover
check "image whose config does not parse: refused" '[ $RC != 0 ] && ! called "systemctl stop"'

reset baremetal; FAKE_CERT_EXPIRING=1 cutover
check "certificate expiring soon: refused" '[ $RC != 0 ] && ! called "systemctl stop"'

reset baremetal; FAKE_KEY_PUB=other cutover
check "certificate and key mismatch: refused" '[ $RC != 0 ] && ! called "systemctl stop"'

reset baremetal; echo "openresty -s reload" > "$T/renew.sh"; cutover
check "renewal script that only reloads bare-metal: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "renew"'
echo "docker exec blot-proxy-blue openresty -s reload" > "$T/renew.sh"

reset baremetal; touch "$FAKE/all/blot-proxy-green"; cutover
check "a proxy container already exists: refused, points at blue-green.sh" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "blue-green.sh"'

reset baremetal; TMUX= cutover
check "outside tmux: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "tmux"'

reset container; cutover
check "bare-metal not running: refused" '[ $RC != 0 ] && ! called "systemctl stop"'

echo "blue-green.sh"

reset container; bluegreen
check "success: green starts, blue drains and is only removed afterwards" '[ $RC = 0 ] && before "docker start blot-proxy-green" "docker stop --time 30 blot-proxy-blue" && before "docker stop --time 30" "docker rm blot-proxy-blue"'
check "success: green becomes permanent last" 'before "docker rm blot-proxy-blue" "docker update --restart unless-stopped blot-proxy-green" && serving container'

reset container; FAKE_UNHEALTHY=blot-proxy-green bluegreen
check "new colour never healthy: old one is never stopped" '[ $RC != 0 ] && ! called "docker stop" && called "docker rm -f blot-proxy-green" && serving container'

reset container; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "checks fail after the old one stops: old one restarted, new removed" '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && called "docker rm -f blot-proxy-green" && ! called "docker rm blot-proxy-blue"'

reset container; FAKE_PURGE_FAIL=1 bluegreen
check "purge endpoint lost after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue"'

reset container; FAKE_STDOUT_LOGS=1 bluegreen
check "image that logs to stdout: refused before starting anything" '[ $RC != 0 ] && ! called "docker create"'

reset baremetal; bluegreen
check "bare-metal still serving and no container: refused, points at the cutover script" '[ $RC != 0 ] && ! called "docker create" && mentions "cutover-from-baremetal.sh"'

reset container; FAKE_CONTAINER_CODE=502 bluegreen
check "site unhealthy before the deploy: not swapped" '[ $RC != 0 ] && ! called "docker create"'

echo
echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
