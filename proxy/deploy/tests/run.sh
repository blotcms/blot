#!/usr/bin/env bash
#
# Drives blue-green.sh and try-issuance.sh against fake docker, systemctl,
# curl and openssl, to check the order of operations and, above all, that
# every failure puts the previous proxy back. Needs no Docker and no
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

cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
R="$FAKE/running"; mkdir -p "$R"
name_arg() { while [ $# -gt 0 ]; do [ "$1" = --name ] && { echo "$2"; return; }; shift; done; }
case "$1" in
  image) exit 0 ;;
  images) for i in ${FAKE_IMAGES-}; do [[ "$i" == "$2":* ]] && echo "$i"; done; exit 0 ;;
  rmi) [[ " ${FAKE_IMAGE_IN_USE:-} " != *" ${!#} "* ]]; exit ;;
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
    if [[ "$n" == blot-proxy-[bg]* ]]; then
      # what the real container does once nginx is up: worker 0 logs the
      # outcome of rebuilding the purge index, to the shared error.log, or to
      # stderr (docker logs) for an ALLOW_STDOUT_LOGS=1 image
      mkdir -p "$FAKE/started" "$FAKE/dlogs"
      date -u +%Y-%m-%dT%H:%M:%S.000000000Z > "$FAKE/started/$n"
      stamp=$(date -u '+%Y/%m/%d %H:%M:%S')
      line=""
      if [ -n "${FAKE_REHYDRATE_ERROR:-}" ]; then line="$stamp [error] 7#7: *1 rehydrate: could not add to index, increase lua_shared_dict cacher_dictionary"
      elif [ -z "${FAKE_NO_REHYDRATE:-}" ]; then line="$stamp [notice] 7#7: *1 rehydrate: complete files=200000 hosts=5000 unparsed=0 seconds=2"; fi
      if [ -n "$line" ]; then
        if [ -n "${FAKE_REHYDRATE_VIA_LOGS_ONLY:-}" ]; then echo "$line" >> "$FAKE/dlogs/$n"; else echo "$line" >> "$PROXY_LOG_DIR/error.log"; fi
      fi
    fi
    if [[ "$n" == blot-proxy-* ]]; then
      if [ "$(cat "$FAKE/serving")" = baremetal ]; then rm -f "$R/$n"; else echo container > "$FAKE/serving"; fi
    fi ;;
  stop) n="${!#}"; rm -f "$R/$n"; touch "$FAKE/stopped"
    [ -n "$(ls "$R" | grep '^blot-proxy-[bg]')" ] || echo none > "$FAKE/serving" ;;
  rm) n="${!#}"; rm -f "$R/$n" "$FAKE/all/$n"
    [ -n "$(ls "$R" | grep '^blot-proxy-[bg]')" ] || { [ "$(cat "$FAKE/serving")" != container ] || echo none > "$FAKE/serving"; } ;;
  update) [ -z "${FAKE_UPDATE_FAILS:-}" ] || exit 1 ;;
  logs) cat "$FAKE/dlogs/${!#}" 2>/dev/null ;;
  inspect) cat "$FAKE/started/${!#}" 2>/dev/null ;;
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
if [[ " $* " == *" scan "* ]]; then
  # common.sh's custom_cert_domains: a cursor line (0 = done), then the keys
  if [ -n "${FAKE_SCAN_FAIL:-}" ]; then echo "ERR fake scan failure"; exit 1; fi
  if [ -n "${FAKE_SCAN_ERROR_REPLY:-}" ]; then echo "LOADING Redis is loading the dataset in memory"; exit 0; fi
  echo 0
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
      [[ "$*" == *" -in "* ]] || served="$(cat)"
      if [[ "$*" != *" -in "* ]] && [[ "$served" == *custom* ]]; then
        # a custom domain: the certificate comes from Redis, not the wildcard file
        if [ -n "${FAKE_NO_CUSTOM_CERT:-}" ] && [[ "$served" == *"$FAKE_NO_CUSTOM_CERT"* ]]; then :
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
  PROXY_CERT_DIR="$T/certs" PROXY_DEPLOY_LOCK="$T/lock" \
  PROXY_DEPLOY_SLEEP=true PROXY_HEALTH_TIMEOUT=1 PROXY_REHYDRATE_TIMEOUT=1 TMUX=fake # nap() is a no-op, so a refusal busy-waits out PROXY_HEALTH_TIMEOUT real seconds

pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { failed=$((failed + 1)); echo "  FAIL $*"; echo "----- calls"; sed 's/^/    /' "$FAKE/calls"; echo "----- output"; sed 's/^/    /' "$T/out"; }

# reset [baremetal|container|none]: fresh host state, `serving` says who owns :443
reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE/running" "$FAKE/all"; : > "$FAKE/calls"; rm -f "$PROXY_LOG_DIR/error.log"
  unset "${!FAKE_@}" 2>/dev/null; export FAKE="$T/fake"
  if [ "$1" = none ]; then echo none > "$FAKE/serving"
  elif [ "$1" = baremetal ]; then touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving"
  else touch "$FAKE/running/blot-proxy-blue" "$FAKE/all/blot-proxy-blue"; echo container > "$FAKE/serving"; fi
}
line() { grep -n -m1 -- "$1" "$FAKE/calls" | cut -d: -f1; }
called() { grep -q -- "$1" "$FAKE/calls"; }
before() { local a b; a=$(line "$1"); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
after_last() { local a b; a=$(grep -n -- "$1" "$FAKE/calls" | tail -1 | cut -d: -f1); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -gt "$b" ]; }

bluegreen() { bash "$DEPLOY/blue-green.sh" img:2 >"$T/out" 2>&1; RC=$?; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
serving() { [ "$(cat "$FAKE/serving")" = "$1" ]; }
mentions() { grep -q -- "$1" "$T/out"; }

echo "custom-domain certificates"

reset container; bluegreen
check "success: the custom-domain certificates are recorded and still match after the swap" '[ $RC = 0 ] && mentions "2 of 2 in Redis are being served"'

reset container; FAKE_CUSTOM_DOMAINS="" bluegreen
check "no custom-domain certificate to compare: refused (unless skipped)" '[ $RC != 0 ] && ! called "docker create" && mentions "nothing to compare"'

reset container; FAKE_CUSTOM_DOMAINS="" PROXY_SKIP_CERT_SWEEP=1 bluegreen
check "PROXY_SKIP_CERT_SWEEP=1 skips the comparison" '[ $RC = 0 ] && mentions "not comparing"'

reset container; FAKE_CUSTOM_FP_AFTER_STOP=B bluegreen
check "a custom-domain certificate differs after the swap: rolled back" '[ $RC != 0 ] && called "docker start blot-proxy-blue" && ! called "docker rm blot-proxy-blue" && mentions "custom-domain certificates"'

echo "try-issuance.sh"

issue() { bash "$DEPLOY/try-issuance.sh" img:3 "$@" >"$T/out" 2>&1; RC=$?; }

reset container; issue throwaway.example.org
check "issues from staging in its own container, then removes the keys and the container" '[ $RC = 0 ] && called "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" && called "redis-cli -h 10.0.0.5 set domain:throwaway.example.org" && called "redis-cli -h 10.0.0.5 del domain:throwaway.example.org ssl:throwaway.example.org:latest" && called "docker rm -f blot-proxy-issuance" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'
check "the throwaway container uses no cache, log or auto-ssl volume and is not published beyond loopback" '! called "run -d.*/var/cache/openresty" && ! called "run -d.*/etc/resty-auto-ssl" && called "127.0.0.1:18444:443"'

reset container; FAKE_NO_ISSUE=1 PROXY_ISSUANCE_ATTEMPTS=2 issue throwaway.example.org
check "no staging certificate: fails, and still cleans up" '[ $RC != 0 ] && mentions "no staging certificate" && called "redis-cli -h 10.0.0.5 del" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'

reset container; FAKE_KEY_EXISTS=1 issue real-customer.example.org
check "a domain Redis already knows: refused, and its keys are never deleted" '[ $RC != 0 ] && ! called "docker run" && ! called "redis-cli.* del" && ! called "redis-cli.* set" && mentions "not a throwaway"'

reset container; issue staging.blot.test
check "a domain under the site's own: refused" '[ $RC != 0 ] && ! called "docker run" && mentions "separate throwaway"'

echo "PROXY_ACME_CA"

echo "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset container; bluegreen
check "a staging ACME directory in proxy.env: refused before anything runs" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
reset container; PROXY_ALLOW_ACME_CA=1 bluegreen
check "PROXY_ALLOW_ACME_CA=1 overrides it" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_ACME_CA=https://acme-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset container; bluegreen
check "the production ACME directory is accepted" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

echo "PROXY_ACME_CA=" >> "$T/proxy.env"
reset container; bluegreen
check "an empty PROXY_ACME_CA in proxy.env: refused (it would override the default with nothing)" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
sed -i.bak '/^PROXY_ACME_CA=$/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_RESOLVER=''" >> "$T/proxy.env"
reset container; bluegreen
check "any other empty PROXY_* setting is refused too" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_RESOLVER"'
sed -i.bak '/^PROXY_RESOLVER=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

echo "blue-green.sh"

reset container; bluegreen
check "success: green starts, blue drains and is only removed afterwards" '[ $RC = 0 ] && before "docker start blot-proxy-green" "docker stop --time 30 blot-proxy-blue" && before "docker stop --time 30" "docker rm blot-proxy-blue"'
check "success: green gets its restart policy before blue is removed" 'before "docker update --restart unless-stopped blot-proxy-green" "docker rm blot-proxy-blue" && serving container'
check "success: green also gets the CDN static mounts and the fd ulimit" \
  'called "docker create --restart no --name blot-proxy-green --network host --cap-add SYS_NICE --ulimit nofile=65536:65536" \
   && called "-v /var/www/blot/data/static:/var/www/blot/data/static:ro"'

reset container; FAKE_UNHEALTHY=blot-proxy-green bluegreen
check "new colour never healthy: old one is never stopped" '[ $RC != 0 ] && ! called "docker stop" && called "docker rm -f blot-proxy-green" && serving container'

reset container; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "checks fail after the old one stops: old one restarted, new removed" '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && called "docker rm -f blot-proxy-green" && ! called "docker rm blot-proxy-blue"'

reset container; FAKE_UPDATE_FAILS=1 bluegreen
check "restart policy cannot be set: the old one is never stopped, the new one is removed" '[ $RC != 0 ] && ! called "docker stop" && after_last "docker rm -f blot-proxy-green" "docker update" && ! called "docker rm blot-proxy-blue" && serving container'

reset container; bluegreen
check "success: the new colour is restartable BEFORE the old one is stopped" '[ $RC = 0 ] && before "docker update --restart unless-stopped blot-proxy-green" "docker stop"'

reset none; FAKE_UNIT_ENABLED=1 bluegreen
check "fresh start while the bare-metal unit is still enabled: refused" '[ $RC != 0 ] && ! called "docker create" && mentions "systemctl disable --now openresty"'

reset none; bluegreen
check "fresh start (nothing running): the container is checked, then made permanent" '[ $RC = 0 ] && ! called "docker stop" && before "docker start blot-proxy-blue" "docker update --restart unless-stopped blot-proxy-blue" && serving container'

reset none; FAKE_UNHEALTHY=blot-proxy-blue bluegreen
check "fresh start whose container never becomes healthy: removed, nothing left" '[ $RC != 0 ] && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

reset none; FAKE_CONTAINER_CODE=502 bluegreen
check "fresh start whose site checks fail: removed, never made permanent" '[ $RC != 0 ] && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

echo "purge index (rehydrate)"

reset none; FAKE_REHYDRATE_ERROR=1 bluegreen
check "fresh start whose purge index fails to rebuild: refused, container removed, never made permanent" '[ $RC != 0 ] && mentions "purge index" && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

reset none; FAKE_NO_REHYDRATE=1 bluegreen
check "fresh start whose purge index never finishes: refused, container removed" '[ $RC != 0 ] && mentions "rehydrate: complete" && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

reset none; ALLOW_STDOUT_LOGS=1 FAKE_STDOUT_LOGS=1 FAKE_REHYDRATE_VIA_LOGS_ONLY=1 bluegreen
check "fresh start: the line is accepted from docker logs too (ALLOW_STDOUT_LOGS=1 image)" '[ $RC = 0 ]'

reset container; FAKE_REHYDRATE_ERROR=1 bluegreen
check "swap whose new colour fails to rebuild its purge index: old one never stopped, new one removed" '[ $RC != 0 ] && ! called "docker stop" && called "docker rm -f blot-proxy-green" && serving container'

reset container; mkdir -p "$PROXY_LOG_DIR"; echo "2000/01/01 00:00:00 [notice] 1#1: *1 rehydrate: complete files=1 hosts=1 unparsed=0 seconds=1" > "$PROXY_LOG_DIR/error.log"
FAKE_NO_REHYDRATE=1 bluegreen
check "swap: the old colour's earlier 'complete' line does not count for the new one" '[ $RC != 0 ] && ! called "docker stop" && called "docker rm -f blot-proxy-green"'

reset container; mkdir -p "$PROXY_LOG_DIR"; echo "2000/01/01 00:00:00 [error] 1#1: *1 rehydrate: could not add to index" > "$PROXY_LOG_DIR/error.log"
bluegreen
check "swap: an old rehydrate error from before the new colour started is ignored" '[ $RC = 0 ]'

echo "certificates on a fresh start"

reset none; FAKE_NO_CUSTOM_CERT=b.custom.test bluegreen
check "fresh start where a Redis domain gets no certificate: refused, listed, never made permanent" '[ $RC != 0 ] && mentions "b.custom.test" && mentions "1 of 2" && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

reset none; FAKE_NO_CUSTOM_CERT=b.custom.test PROXY_SKIP_CERT_SWEEP=1 bluegreen
check "fresh start with PROXY_SKIP_CERT_SWEEP=1: allowed, and says it skipped" '[ $RC = 0 ] && mentions "not checking custom-domain certificates"'

reset none; bluegreen
check "fresh start where every Redis domain gets a certificate: made permanent" '[ $RC = 0 ] && mentions "all 2 in Redis are being served" && called "docker update --restart unless-stopped blot-proxy-blue"'

reset none; FAKE_CUSTOM_DOMAINS="" bluegreen
check "fresh start with no custom domains in Redis: nothing to serve, allowed" '[ $RC = 0 ]'

reset none; FAKE_CUSTOM_FP_CONTAINER=A bluegreen
check "fresh start where custom domains get the wildcard (auto-ssl fallback): refused, never made permanent" '[ $RC != 0 ] && mentions "no certificate of its own" && mentions "2 of 2" && called "docker rm -f blot-proxy-blue" && ! called "docker update"'

reset none; FAKE_SCAN_FAIL=1 bluegreen
check "fresh start where the Redis SCAN fails: refused, not mistaken for no custom domains" '[ $RC != 0 ] && mentions "SCAN failed" && ! called "docker update"'

reset none; FAKE_SCAN_ERROR_REPLY=1 bluegreen
check "fresh start where SCAN returns an error reply: refused" '[ $RC != 0 ] && mentions "SCAN failed" && ! called "docker update"'

reset container; FAKE_LOCK_HELD=1 bluegreen
check "another deploy holds the lock: refused, nothing touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "already running"'

if [ "$(id -u)" != 0 ]; then # root ignores file modes
  reset container; : > "$T/lock"; chmod 444 "$T/lock"; bluegreen
  check "an existing lock file the user cannot write is opened read-only: the swap proceeds" '[ $RC = 0 ] && called "docker create" && ! mentions "cannot open the deploy lock"'
  chmod 644 "$T/lock"; rm -f "$T/lock"
fi

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
check "bare-metal still serving and no container: refused, says how to hand over" '[ $RC != 0 ] && ! called "docker create" && mentions "systemctl disable --now openresty"'

reset container; FAKE_CONTAINER_CODE=502 bluegreen
check "site unhealthy before the deploy: not swapped" '[ $RC != 0 ] && ! called "docker create"'

reset container; bash "$DEPLOY/blue-green.sh" abc123 >"$T/out" 2>&1; RC=$?
check "a bare commit SHA is pulled from the proxy registry" '[ $RC = 0 ] && called "ghcr.io/blotcms/blot-proxy:abc123"'

echo
echo "old images"

reset container; FAKE_IMAGES="img:1 img:2 img:0 other:1" bluegreen
check "swap: removes the repository's other images, keeps the deployed one and other repositories" '[ $RC = 0 ] && called "docker rmi img:1" && called "docker rmi img:0" && ! called "docker rmi img:2" && ! called "docker rmi other:1" && mentions "Removed old image img:1"'

reset none; FAKE_IMAGES="img:1 img:2" bluegreen
check "fresh start: removes the old image too" '[ $RC = 0 ] && called "docker rmi img:1" && ! called "docker rmi img:2"'

reset container; FAKE_IMAGES="img:1 img:2" FAKE_IMAGE_IN_USE="img:1" bluegreen
check "an image still in use is left alone, and the deploy still succeeds" '[ $RC = 0 ] && ! mentions "Removed old image img:1"'

reset container; FAKE_IMAGES="img:1 img:2" FAKE_UNHEALTHY=blot-proxy-green bluegreen
check "a failed deploy removes no images" '[ $RC != 0 ] && ! called "docker rmi"'

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
