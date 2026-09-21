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
printf 'BLOT_HOST=blot.test\nPROXY_REDIS_HOST=10.0.0.5\nPROXY_PRIVATE_IP=10.0.0.9\n' > "$T/proxy.env"
echo "docker exec blot-proxy-blue openresty -s reload" > "$T/renew.sh"
echo "docker restart blot-proxy-blue" > "$T/identify-expiring-certs.sh"
cp "$T/identify-expiring-certs.sh" "$T/purge-expired-ssl.sh"

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
  create) [ -z "${FAKE_CREATE_FAILS:-}" ] || exit 1; n=$(name_arg "$@"); mkdir -p "$FAKE/all"; touch "$FAKE/all/$n" ;;
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
  update) [ -z "${FAKE_UPDATE_FAILS:-}" ] || exit 1 ;;
  logs) ;;
  exec)
    n="$2"
    if [[ "$*" == *"--unix-socket"* ]]; then [ -e "$R/$n" ] && [ "$n" != "${FAKE_UNHEALTHY:-}" ]; exit; fi
    if [[ "$3" == printenv ]]; then [ -z "${FAKE_NO_PURGE_ENV:-}" ] && echo http://10.0.0.9:8077; exit 0; fi
    if [[ "$3" == node ]]; then [ -z "${FAKE_PURGE_FAIL:-}" ]; exit; fi ;;
esac
exit 0
F
cat > "$T/bin/curl" <<'F'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls"
args="$*"
if [[ "$args" == *"/health"* ]]; then
  if [ -n "${FAKE_UPSTREAM_DOWN:-}" ] && [[ "$args" == *":$FAKE_UPSTREAM_DOWN/"* ]]; then printf 000; exit 7; fi
  printf 200; exit 0
fi
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
  is-enabled) [ -n "${FAKE_UNIT_ENABLED:-}" ] ;;
  stop) rm -f "$FAKE/unit_active"; echo none > "$FAKE/serving" ;;
  start) [ -z "${FAKE_BM_START_FAILS:-}" ] || exit 1; touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving" ;;
  disable) [ -z "${FAKE_DISABLE_FAILS:-}" ] || [ -e "$FAKE/disable_failed" ] || { touch "$FAKE/disable_failed"; exit 1; }; touch "$FAKE/unit_disabled" ;;
  enable) rm -f "$FAKE/unit_disabled" ;;
esac
F
cat > "$T/bin/timeout" <<'F'
#!/usr/bin/env bash
shift
if [[ "$*" == */dev/tcp/* ]]; then [ -z "${FAKE_REDIS_DOWN:-}" ]; exit; fi
exec "$@"
F
cat > "$T/bin/redis-cli" <<'F'
#!/usr/bin/env bash
if [[ "$*" == *--scan* ]]; then
  for d in ${FAKE_CUSTOM_DOMAINS-a.custom.test b.custom.test}; do echo "ssl:$d:latest"; done
  exit
fi
echo "redis-cli $*" >> "$FAKE/calls"
if [[ "$*" == *" exists "* ]]; then echo "${FAKE_KEY_EXISTS:-0}"; fi
F
cat > "$T/bin/flock" <<'F'
#!/usr/bin/env bash
[ -z "${FAKE_LOCK_HELD:-}" ]
F
cat > "$T/bin/sudo" <<'F'
#!/usr/bin/env bash
shift; exec "$@"
F
cat > "$T/bin/openssl" <<'F'
#!/usr/bin/env bash
case "$1" in
  x509)
    if [[ "$*" == *-issuer* ]]; then [ -z "${FAKE_NO_ISSUE:-}" ] && echo "issuer=O = (STAGING) Let's Encrypt"; exit 0; fi
    if [[ "$*" == *-checkend* ]]; then [ -z "${FAKE_CERT_EXPIRING:-}" ]; exit; fi
    if [[ "$*" == *-pubkey* ]]; then echo pub; exit; fi
    if [[ "$*" == *-fingerprint* ]]; then
      if [[ "$*" != *" -in "* ]] && [[ "$(cat)" == *custom* ]]; then
        # a custom domain: the certificate comes from Redis, not the wildcard file
        if [ "$(cat "$FAKE/sclient_port" 2>/dev/null)" = 18443 ]; then echo "fp=${FAKE_CUSTOM_FP_REHEARSAL:-C}"
        elif [ -n "${FAKE_CUSTOM_FP_AFTER_STOP:-}" ] && [ -e "$FAKE/stopped" ]; then echo "fp=$FAKE_CUSTOM_FP_AFTER_STOP"
        elif [ "$(cat "$FAKE/serving")" = container ]; then echo "fp=${FAKE_CUSTOM_FP_CONTAINER:-C}"
        elif [[ "$(cat "$FAKE/serving")" = baremetal ]]; then echo "fp=${FAKE_CUSTOM_FP_BAREMETAL:-C}"; fi
        exit
      fi
      if [[ "$*" == *" -in "* ]]; then echo fp=A
      elif [ "$(cat "$FAKE/sclient_port" 2>/dev/null)" = 443 ]; then echo "fp=${FAKE_SERVED_FP:-A}"   # only the live port
      else echo fp=A; fi; exit; fi ;;
  pkey) echo "${FAKE_KEY_PUB:-pub}" ;;
  sha256) sha256sum ;;
  s_client) [[ "$*" =~ :([0-9]+)\  ]] && echo "${BASH_REMATCH[1]}" > "$FAKE/sclient_port"
    [[ "$*" =~ -servername\ ([^ ]+) ]] && echo "served ${BASH_REMATCH[1]}" || echo served ;;
esac
F
chmod +x "$T"/bin/*
export PATH="$T/bin:$PATH"

export PROXY_ENV_FILE="$T/proxy.env" PROXY_CACHE_DIR="$T/cache" PROXY_LOG_DIR="$T/logs" \
  PROXY_CERT_DIR="$T/certs" PROXY_DEPLOY_LOCK="$T/lock" PROXY_RENEW_SCRIPT="$T/renew.sh" \
  PROXY_DEPLOY_SLEEP=true PROXY_HEALTH_TIMEOUT=1 TMUX=fake

pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { failed=$((failed + 1)); echo "  FAIL $*"; echo "----- calls"; sed 's/^/    /' "$FAKE/calls"; echo "----- output"; sed 's/^/    /' "$T/out"; }

# reset [baremetal|container|none]: fresh host state, `serving` says who owns :443
reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE/running" "$FAKE/all"; : > "$FAKE/calls"
  unset "${!FAKE_@}" 2>/dev/null; export FAKE="$T/fake"
  if [ "$1" = none ]; then echo none > "$FAKE/serving"
  elif [ "$1" = baremetal ]; then touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving"
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
check "success: the container is made permanent, then bare-metal disabled, only at the end" 'before "docker start blot-proxy-blue" "docker update --restart unless-stopped" && before "docker update --restart" "systemctl disable openresty" && serving container'
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

reset baremetal; FAKE_UPDATE_FAILS=1 cutover
check "finalizing fails (docker update): rolls back, bare-metal never disabled" '[ $RC != 0 ] && serving baremetal && ! called "systemctl disable" && called "docker rm -f blot-proxy-blue"'

reset baremetal; FAKE_DISABLE_FAILS=1 cutover
check "finalizing fails (systemctl disable): bare-metal is re-enabled and started" '[ $RC != 0 ] && serving baremetal && [ ! -e "$FAKE/unit_disabled" ] && called "systemctl enable openresty" && after_last "systemctl start openresty" "systemctl disable"'

reset baremetal; sed -i.bak 's/^PROXY_REDIS_HOST=.*/PROXY_REDIS_HOST=/' "$T/proxy.env"; cutover
check "empty PROXY_REDIS_HOST: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "PROXY_REDIS_HOST"'
mv "$T/proxy.env.bak" "$T/proxy.env"

reset baremetal; FAKE_NO_PURGE_ENV=1 cutover
check "Node container without BLOT_REVERSE_PROXY_URLS: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "BLOT_REVERSE_PROXY_URLS"'

reset baremetal; sed -i.bak 's/^PROXY_PRIVATE_IP=.*/PROXY_PRIVATE_IP=/' "$T/proxy.env"; cutover
check "empty PROXY_PRIVATE_IP: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "PROXY_PRIVATE_IP"'
mv "$T/proxy.env.bak" "$T/proxy.env"

reset baremetal; echo "sudo systemctl restart openresty" > "$T/purge-expired-ssl.sh"; cutover
check "certificate repair helper that restarts bare-metal: refused" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "purge-expired-ssl.sh"'
cp "$T/identify-expiring-certs.sh" "$T/purge-expired-ssl.sh"

for bad in abc -5 1.5 ""; do
  reset baremetal; bash "$DEPLOY/cutover-from-baremetal.sh" --yes --soak "$bad" img:1 >"$T/out" 2>&1; RC=$?
  check "invalid soak '$bad': refused before anything runs" '[ $RC != 0 ] && ! called "systemctl stop" && ! called "docker"'
done

reset baremetal; FAKE_CONTAINER_CODE=502 FAKE_BM_START_FAILS=1 cutover
check "rollback cannot start bare-metal: the container is started again and kept" '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && ! after_last "docker rm -f blot-proxy-blue" "docker stop"'

reset baremetal; FAKE_DISABLE_FAILS=1 FAKE_BM_START_FAILS=1 cutover
check "finalize fails and bare-metal cannot come back: container kept, unit ends disabled" '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && [ -e "$FAKE/unit_disabled" ]'

reset baremetal; FAKE_CREATE_FAILS=1 cutover
check "docker create fails: the container is cleaned up, bare-metal untouched" '[ $RC != 0 ] && serving baremetal && ! called "systemctl stop" && called "docker rm -f blot-proxy-blue"'

reset baremetal; FAKE_LOCK_HELD=1 cutover
check "another deploy holds the lock: refused, nothing changed" '[ $RC != 0 ] && ! called "systemctl stop" && ! called "docker create" && mentions "already running"'

reset baremetal; FAKE_REDIS_DOWN=1 cutover
check "Redis unreachable after the cutover: rolls back" '[ $RC != 0 ] && serving baremetal && mentions "Redis"'

reset baremetal; FAKE_UPSTREAM_DOWN=8089 cutover
check "an upstream is down: refused before anything changes" '[ $RC != 0 ] && ! called "systemctl stop"'

echo "custom-domain certificates"

reset baremetal; cutover
check "success: the custom-domain certificates are recorded and still match after the cutover" '[ $RC = 0 ] && mentions "2 of 2 in Redis are being served"'

reset baremetal; FAKE_CUSTOM_FP_REHEARSAL=B cutover --dry-run
check "rehearsal serves a different custom-domain certificate: refused before the stop" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "custom-domain certificates"'

reset baremetal; FAKE_CUSTOM_FP_CONTAINER=B cutover
check "container serves a different custom-domain certificate live: rolls back to bare-metal" '[ $RC != 0 ] && serving baremetal && ! called "systemctl disable" && mentions "custom-domain certificates"'

reset baremetal; FAKE_CUSTOM_DOMAINS="" cutover
check "no custom-domain certificate to compare: refused (unless skipped)" '[ $RC != 0 ] && ! called "systemctl stop" && mentions "nothing to compare"'

reset baremetal; FAKE_CUSTOM_DOMAINS="" PROXY_SKIP_CERT_SWEEP=1 cutover
check "PROXY_SKIP_CERT_SWEEP=1 skips the comparison" '[ $RC = 0 ] && mentions "not comparing"'

reset container; FAKE_CUSTOM_FP_AFTER_STOP=B bluegreen
check "blue-green: a custom-domain certificate differs after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue" && ! called "docker rm blot-proxy-blue" && mentions "custom-domain certificates"'

echo "try-issuance.sh"

issue() { bash "$DEPLOY/try-issuance.sh" img:3 "$@" >"$T/out" 2>&1; RC=$?; }

reset baremetal; issue throwaway.example.org
check "issues from staging in its own container, then removes the keys and the container" '[ $RC = 0 ] && called "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" && called "redis-cli -h 10.0.0.5 set domain:throwaway.example.org" && called "redis-cli -h 10.0.0.5 del domain:throwaway.example.org ssl:throwaway.example.org:latest" && called "docker rm -f blot-proxy-issuance" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'
check "the throwaway container uses no cache, log or auto-ssl volume and is not published beyond loopback" '! called "run -d.*/var/cache/openresty" && ! called "run -d.*/etc/resty-auto-ssl" && called "127.0.0.1:18444:443"'

reset baremetal; FAKE_NO_ISSUE=1 PROXY_ISSUANCE_ATTEMPTS=2 issue throwaway.example.org
check "no staging certificate: fails, and still cleans up" '[ $RC != 0 ] && mentions "no staging certificate" && called "redis-cli -h 10.0.0.5 del" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'

reset baremetal; FAKE_KEY_EXISTS=1 issue real-customer.example.org
check "a domain Redis already knows: refused, and its keys are never deleted" '[ $RC != 0 ] && ! called "docker run" && ! called "redis-cli.* del" && ! called "redis-cli.* set" && mentions "not a throwaway"'

reset baremetal; issue staging.blot.test
check "a domain under the site's own: refused" '[ $RC != 0 ] && ! called "docker run" && mentions "separate throwaway"'

echo "PROXY_ACME_CA"

reset baremetal; echo "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"; cutover --dry-run
check "a staging ACME directory in proxy.env: refused before anything runs" '[ $RC != 0 ] && ! called "docker run" && mentions "PROXY_ACME_CA"'
reset container; bluegreen
check "a staging ACME directory in proxy.env: blue-green refuses too" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
reset baremetal; PROXY_ALLOW_ACME_CA=1 cutover --dry-run
check "PROXY_ALLOW_ACME_CA=1 overrides it" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_ACME_CA=https://acme-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset baremetal; cutover --dry-run
check "the production ACME directory is accepted" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

reset baremetal; echo "PROXY_ACME_CA=" >> "$T/proxy.env"; cutover --dry-run
check "an empty PROXY_ACME_CA in proxy.env: refused (it would override the default with nothing)" '[ $RC != 0 ] && ! called "docker run" && mentions "PROXY_ACME_CA"'
reset container; bluegreen
check "an empty PROXY_ACME_CA in proxy.env: blue-green refuses too" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
sed -i.bak '/^PROXY_ACME_CA=$/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
reset baremetal; echo "PROXY_RESOLVER=''" >> "$T/proxy.env"; cutover --dry-run
check "any other empty PROXY_* setting is refused too" '[ $RC != 0 ] && ! called "docker run" && mentions "PROXY_RESOLVER"'
sed -i.bak '/^PROXY_RESOLVER=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

echo "blue-green.sh"

reset container; bluegreen
check "success: green starts, blue drains and is only removed afterwards" '[ $RC = 0 ] && before "docker start blot-proxy-green" "docker stop --time 30 blot-proxy-blue" && before "docker stop --time 30" "docker rm blot-proxy-blue"'
check "success: green gets its restart policy before blue is removed" 'before "docker update --restart unless-stopped blot-proxy-green" "docker rm blot-proxy-blue" && serving container'

reset container; FAKE_UNHEALTHY=blot-proxy-green bluegreen
check "new colour never healthy: old one is never stopped" '[ $RC != 0 ] && ! called "docker stop" && called "docker rm -f blot-proxy-green" && serving container'

reset container; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "checks fail after the old one stops: old one restarted, new removed" '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && called "docker rm -f blot-proxy-green" && ! called "docker rm blot-proxy-blue"'

reset container; FAKE_UPDATE_FAILS=1 bluegreen
check "restart policy cannot be set: the old one is never stopped, the new one is removed" '[ $RC != 0 ] && ! called "docker stop" && after_last "docker rm -f blot-proxy-green" "docker update" && ! called "docker rm blot-proxy-blue" && serving container'

reset container; bluegreen
check "success: the new colour is restartable BEFORE the old one is stopped" '[ $RC = 0 ] && before "docker update --restart unless-stopped blot-proxy-green" "docker stop"'

reset none; FAKE_UNIT_ENABLED=1 bluegreen
check "fresh start while the bare-metal unit is still enabled: refused" '[ $RC != 0 ] && ! called "docker create" && mentions "cutover-from-baremetal.sh"'

reset baremetal; echo "PROXY_UPSTREAM_GREEN=127.0.0.1:9999" >> "$T/proxy.env"; FAKE_UPSTREAM_DOWN=9999 cutover
check "custom upstream down: refused in preflight, before the rehearsal" '[ $RC != 0 ] && ! called "docker run -d" && ! called "systemctl stop" && mentions "PROXY_UPSTREAM_GREEN"'
sed -i.bak '/^PROXY_UPSTREAM_GREEN=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

reset container; FAKE_LOCK_HELD=1 bluegreen
check "another deploy holds the lock: refused, nothing touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "already running"'

reset container; FAKE_REDIS_DOWN=1 bluegreen
check "Redis unreachable after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue" && ! called "docker rm blot-proxy-blue"'

reset container; FAKE_UPSTREAM_DOWN=8089 bluegreen
check "master upstream unreachable after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue" && ! called "docker rm blot-proxy-blue"'

reset container; touch "$FAKE/running/blot-proxy-green" "$FAKE/all/blot-proxy-green"; bluegreen
check "both colours running: refused, nothing touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "both running"'

reset container; FAKE_PURGE_FAIL=1 bluegreen
check "purge endpoint lost after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue"'

reset container; FAKE_STDOUT_LOGS=1 bluegreen
check "image that logs to stdout: refused before starting anything" '[ $RC != 0 ] && ! called "docker create"'

reset baremetal; bluegreen
check "bare-metal still serving and no container: refused, points at the cutover script" '[ $RC != 0 ] && ! called "docker create" && mentions "cutover-from-baremetal.sh"'

reset container; FAKE_CONTAINER_CODE=502 bluegreen
check "site unhealthy before the deploy: not swapped" '[ $RC != 0 ] && ! called "docker create"'

reset container; bash "$DEPLOY/blue-green.sh" abc123 >"$T/out" 2>&1; RC=$?
check "a bare commit SHA is pulled from the proxy registry" '[ $RC = 0 ] && called "ghcr.io/blotcms/blot-proxy:abc123"'

echo
echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
