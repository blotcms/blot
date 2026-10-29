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
mkdir -p "$T/bin" "$T/certs" "$T/disk-cache" "$T/logs" "$FAKE"
echo cert > "$T/certs/letsencrypt-domain.pem"; echo key > "$T/certs/letsencrypt-domain.key"
printf 'BLOT_HOST=blot.test\nPROXY_REDIS_HOST=10.0.0.5\nPROXY_PRIVATE_IP=10.0.0.9\n' > "$T/proxy.env"

cat > "$T/bin/docker" <<'F'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE/calls"
R="$FAKE/running"; mkdir -p "$R"
name_arg() { while [ $# -gt 0 ]; do [ "$1" = --name ] && { echo "$2"; return; }; shift; done; }
case "$1" in
  image) if [[ "$*" == *"{{.Id}}"* ]]; then echo "${!#}"; fi; exit 0 ;;
  images) for i in ${FAKE_IMAGES-}; do [[ "$i" == "$2":* ]] && echo "$i"; done; exit 0 ;;
  rmi) [[ " ${FAKE_IMAGE_IN_USE:-} " != *" ${!#} "* ]]; exit ;;
  pull) exit 0 ;;
  network) echo 172.17.0.1 ;;
  ps) if [[ "$*" == *" -a "* ]]; then ls "$FAKE/all" 2>/dev/null; else ls "$R"; fi; exit 0 ;;
  run)
    # reset_cache_dir: the foreground container moves the entries aside, the
    # detached one deletes them
    if [[ "$*" == *"--entrypoint sh"* ]]; then
      [ -z "${FAKE_RESET_FAILS:-}" ] || exit 1
      exit 0
    fi
    if [[ " $* " == *" -d "* ]]; then n=$(name_arg "$@"); touch "$R/$n" "$FAKE/all/$n" 2>/dev/null || { mkdir -p "$FAKE/all"; touch "$R/$n" "$FAKE/all/$n"; }; exit 0; fi
    if [[ "$*" == *"openresty -t"* ]]; then [ -z "${FAKE_VALIDATE_FAIL:-}" ] || { echo "nginx: [emerg] bad"; exit 1; }; exit 0; fi
    if [[ "$*" == *"access_log"* ]]; then [ -z "${FAKE_STDOUT_LOGS:-}" ]; exit; fi ;;
  create) [ -z "${FAKE_CREATE_FAILS:-}" ] || exit 1; n=$(name_arg "$@"); mkdir -p "$FAKE/all" "$FAKE/image"; touch "$FAKE/all/$n"
    echo "${!#}" > "$FAKE/image/$n" ;;
  rename) mv "$R/$2" "$R/$3" 2>/dev/null; mv "$FAKE/all/$2" "$FAKE/all/$3" 2>/dev/null; mv "$FAKE/image/$2" "$FAKE/image/$3" 2>/dev/null; exit 0 ;;
  start)
    n="$2"; [ "$n" != "${FAKE_START_FAILS:-}" ] || exit 1
    touch "$R/$n"
    if [[ "$n" =~ ^blot-(proxy-)?(blue|green)(-previous)?$ ]]; then
      if [ "$(cat "$FAKE/serving")" = baremetal ]; then rm -f "$R/$n"; else echo container > "$FAKE/serving"; fi
    fi ;;
  stop) n="${!#}"; rm -f "$R/$n"; touch "$FAKE/stopped"
    # the health cron docker-restarts a draining container that went unhealthy
    [ "$n" != "${FAKE_COMES_BACK:-}" ] || { touch "$R/$n"; exit 0; }
    [ -n "$(ls "$R" | grep -E '^blot-(proxy-)?(blue|green)')" ] || echo none > "$FAKE/serving" ;;
  rm) n="${!#}"; [ "$n" != "${FAKE_RM_FAILS:-}" ] || exit 1
    rm -f "$R/$n" "$FAKE/all/$n"
    [ -n "$(ls "$R" | grep -E '^blot-(proxy-)?(blue|green)')" ] || { [ "$(cat "$FAKE/serving")" != container ] || echo none > "$FAKE/serving"; } ;;
  update) [ -z "${FAKE_UPDATE_FAILS:-}" ] || exit 1 ;;
  logs) cat "$FAKE/dlogs/${!#}" 2>/dev/null ;;
  inspect) if [[ "$*" == *"{{.Image}}"* ]]; then cat "$FAKE/image/${!#}" 2>/dev/null; exit 0; fi
    cat "$FAKE/started/${!#}" 2>/dev/null ;;
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
  if [ -n "${FAKE_UPSTREAM_FLAKY:-}" ] && [[ "$args" == *":$FAKE_UPSTREAM_FLAKY/"* ]]; then
    n=$(cat "$FAKE/flaky" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/flaky"
    [ "$n" -ge 2 ] || { printf 000; exit 7; }
  fi
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
if [[ " $* " == *" get blot:openresty:ssl:pem "* ]]; then echo "${FAKE_REDIS_WILDCARD_PEM:-}"; exit; fi
if [ "$*" = "-h 10.0.0.5 --raw" ]; then
  # common.sh's expired_cert_domains: "get ssl:<domain>:latest" lines on stdin,
  # one stored certificate JSON line back for each
  while read -r _ key; do
    d=${key#ssl:}; d=${d%:latest}
    if [[ " ${FAKE_EXPIRED_DOMAINS:-} " == *" $d "* ]] && { [ -z "${FAKE_EXPIRED_ONLY_AT_BASELINE:-}" ] || [ ! -e "$FAKE/stopped" ]; }; then
      echo '{"expiry":1}'
    else
      echo '{"expiry":99999999999}'
    fi
  done
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
      if [[ "$served" == *redis-wildcard* ]]; then echo fp=R; exit; fi
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

export PROXY_ENV_FILE="$T/proxy.env" PROXY_DISK_CACHE_DIR="$T/disk-cache" PROXY_LOG_DIR="$T/logs" \
  PROXY_CERT_DIR="$T/certs" PROXY_DEPLOY_LOCK="$T/lock" \
  PROXY_DEPLOY_SLEEP=true PROXY_HEALTH_TIMEOUT=1 PROXY_UPSTREAM_WAIT=0 TMUX=fake # nap() is a no-op, so a refusal busy-waits out PROXY_HEALTH_TIMEOUT real seconds

pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { failed=$((failed + 1)); echo "  FAIL $*"; echo "----- calls"; sed 's/^/    /' "$FAKE/calls"; echo "----- output"; sed 's/^/    /' "$T/out"; }

# up <container> [image]: a container that is running (it was created from <image>)
up() { touch "$FAKE/running/$1" "$FAKE/all/$1"; echo "${2:-img:old}" > "$FAKE/image/$1"; }

# reset [baremetal|none|legacy|steady]: fresh host state, `serving` says who owns :443
#   none      no proxy         legacy   blot-proxy-blue alone (the single proxy of before)
#   baremetal a systemd unit   steady   blot-blue and blot-green, both running img:old
reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE/running" "$FAKE/all" "$FAKE/image"; : > "$FAKE/calls"; rm -f "$PROXY_LOG_DIR/error.log"
  unset "${!FAKE_@}" 2>/dev/null; export FAKE="$T/fake"
  case "$1" in
    none) echo none > "$FAKE/serving" ;;
    baremetal) touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving" ;;
    legacy) up blot-proxy-blue; echo container > "$FAKE/serving" ;;
    steady) up blot-blue; up blot-green; echo container > "$FAKE/serving" ;;
    *) echo "reset: unknown state $1" >&2; exit 2 ;;
  esac
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

reset steady; FAKE_UPSTREAM_FLAKY=8089 PROXY_UPSTREAM_WAIT=60 bluegreen
check "upstream down at first (concurrent Node deploy), healthy on retry: deploys" '[ $RC = 0 ] && called "docker create"'

reset steady; FAKE_UPSTREAM_FLAKY=8089 bluegreen
check "upstream retry disabled (PROXY_UPSTREAM_WAIT=0): refused on the first miss" '[ $RC != 0 ] && ! called "docker create"'

reset steady; bluegreen
check "success: the custom-domain certificates are recorded and still match after each replacement" '[ $RC = 0 ] && mentions "2 of 2 in Redis are being served"'

reset steady; FAKE_CUSTOM_DOMAINS="" bluegreen
check "no custom-domain certificate to compare: refused (unless skipped)" '[ $RC != 0 ] && ! called "docker create" && mentions "nothing to compare"'

reset steady; FAKE_CUSTOM_DOMAINS="" PROXY_SKIP_CERT_SWEEP=1 bluegreen
check "PROXY_SKIP_CERT_SWEEP=1 skips the comparison" '[ $RC = 0 ] && mentions "not comparing"'

reset steady; FAKE_CUSTOM_FP_AFTER_STOP=B bluegreen
check "a custom-domain certificate differs after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker rm -f blot-blue-previous" && mentions "custom-domain certificates"'

reset steady; FAKE_CUSTOM_FP_AFTER_STOP=B FAKE_EXPIRED_DOMAINS="a.custom.test b.custom.test" bluegreen
check "a custom-domain certificate that has expired and is no longer served is not held against the deploy" '[ $RC = 0 ]'

# The replacement issues a new certificate for a domain whose stored one had
# expired, so the fingerprint changes. Expiry is judged before the swap: the
# fake Redis shows the fresh certificate afterwards, so a re-read then would
# call the domain unexpired.
reset steady; FAKE_CUSTOM_FP_AFTER_STOP=B FAKE_EXPIRED_DOMAINS="a.custom.test b.custom.test" FAKE_EXPIRED_ONLY_AT_BASELINE=1 bluegreen
check "a certificate that expired and was reissued by the replacement is judged by its expiry before the replacement" '[ $RC = 0 ]'

echo "try-issuance.sh"

issue() { bash "$DEPLOY/try-issuance.sh" img:3 "$@" >"$T/out" 2>&1; RC=$?; }

reset steady; issue throwaway.example.org
check "issues from staging in its own container, then removes the keys and the container" '[ $RC = 0 ] && called "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" && called "redis-cli -h 10.0.0.5 set domain:throwaway.example.org" && called "redis-cli -h 10.0.0.5 del domain:throwaway.example.org ssl:throwaway.example.org:latest" && called "docker rm -f blot-proxy-issuance" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'
check "the throwaway container uses no cache, log or auto-ssl volume and is not published beyond loopback" '! called "run -d.*/var/cache/openresty" && ! called "run -d.*/etc/resty-auto-ssl" && called "127.0.0.1:18444:443"'

reset steady; FAKE_NO_ISSUE=1 PROXY_ISSUANCE_ATTEMPTS=2 issue throwaway.example.org
check "no staging certificate: fails, and still cleans up" '[ $RC != 0 ] && mentions "no staging certificate" && called "redis-cli -h 10.0.0.5 del" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'

reset steady; FAKE_KEY_EXISTS=1 issue real-customer.example.org
check "a domain Redis already knows: refused, and its keys are never deleted" '[ $RC != 0 ] && ! called "docker run" && ! called "redis-cli.* del" && ! called "redis-cli.* set" && mentions "not a throwaway"'

reset steady; issue staging.blot.test
check "a domain under the site's own: refused" '[ $RC != 0 ] && ! called "docker run" && mentions "separate throwaway"'

echo "PROXY_ACME_CA"

echo "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset steady; bluegreen
check "a staging ACME directory in proxy.env: refused before anything runs" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
reset steady; PROXY_ALLOW_ACME_CA=1 bluegreen
check "PROXY_ALLOW_ACME_CA=1 overrides it" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_ACME_CA=https://acme-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset steady; bluegreen
check "the production ACME directory is accepted" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

echo "PROXY_ACME_CA=" >> "$T/proxy.env"
reset steady; bluegreen
check "an empty PROXY_ACME_CA in proxy.env: refused (it would override the default with nothing)" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
sed -i.bak '/^PROXY_ACME_CA=$/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_RESOLVER=''" >> "$T/proxy.env"
reset steady; bluegreen
check "any other empty PROXY_* setting is refused too" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_RESOLVER"'
sed -i.bak '/^PROXY_RESOLVER=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"


echo "blue-green.sh: steady state (blot-blue and blot-green running)"

running_now() { [ -e "$FAKE/running/$1" ]; }
gone() { ! [ -e "$FAKE/all/$1" ]; }
set_image() { echo "$2" > "$FAKE/image/$1"; }

reset steady; bluegreen
check "success: blue is stopped, kept as -previous, replaced, and only then removed" \
  '[ $RC = 0 ] && before "docker stop --time 30 blot-blue" "docker rename blot-blue blot-blue-previous" && before "docker rename blot-blue blot-blue-previous" "docker create --restart no --name blot-blue" && before "docker start blot-blue" "docker rm -f blot-blue-previous"'
check "success: blue is finished before green is touched, and green goes the same way" \
  'before "docker rm -f blot-blue-previous" "docker stop --time 30 blot-green" && before "docker rename blot-green blot-green-previous" "docker create --restart no --name blot-green" && called "docker rm -f blot-green-previous"'
check "success: each new unit gets its restart policy before its previous one is removed" \
  'before "docker update --restart unless-stopped blot-blue" "docker rm -f blot-blue-previous" && before "docker update --restart unless-stopped blot-green" "docker rm -f blot-green-previous"'
check "success: both units run the new image, nothing else is left, :443 is served" \
  'running_now blot-blue && running_now blot-green && gone blot-blue-previous && gone blot-green-previous && [ "$(cat "$FAKE/image/blot-blue")" = img:2 ] && [ "$(cat "$FAKE/image/blot-green")" = img:2 ] && serving container'
check "success: the units are told which one they are (PROXY_UNIT), and get the fd ulimit and the CDN static mount" \
  'called "docker create --restart no --name blot-blue --network host --cap-add SYS_NICE --ulimit nofile=65536:65536" && called "create .*--name blot-blue .*-e PROXY_UNIT=blue" && called "create .*--name blot-green .*-e PROXY_UNIT=green" && called "-v /var/www/blot/app/blog/static:/var/www/blot/app/blog/static:ro"'
check "success: exactly two stops, blue's and then green's, so one unit is always up" \
  '[ "$(grep -c "docker stop" "$FAKE/calls")" = 2 ]'

reset steady; set_image blot-blue img:2; set_image blot-green img:2; bluegreen
check "a re-run with the image both units already run: nothing is stopped, renamed or created" \
  '[ $RC = 0 ] && ! called "docker stop" && ! called "docker rename" && ! called "docker create" && mentions "nothing to do"'

reset steady; set_image blot-blue img:2; bluegreen
check "blue already on the image (a deploy that stopped after blue): only green is replaced" \
  '[ $RC = 0 ] && ! called "docker stop --time 30 blot-blue" && called "docker stop --time 30 blot-green" && [ "$(cat "$FAKE/image/blot-green")" = img:2 ]'

reset steady; set_image blot-blue img:2; set_image blot-green img:2; FAKE_UNHEALTHY=blot-green bluegreen
check "an unhealthy unit is replaced even on the right image (here the replacement is unhealthy too: rolled back); the healthy one is not touched" \
  '[ $RC != 0 ] && called "docker stop --time 30 blot-green" && ! called "docker stop --time 30 blot-blue"'

reset steady; FAKE_UNHEALTHY=blot-green bluegreen
check "green unhealthy: blue is not stopped (it would leave no healthy proxy), nothing is touched" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker rename" && ! called "docker create" && mentions "refusing to stop blot-blue"'

reset steady; FAKE_UNHEALTHY=blot-blue bluegreen
check "blue never becomes healthy: blue is rolled back from -previous, green is never touched" \
  '[ $RC != 0 ] && called "docker start blot-blue-previous" && after_last "docker rename blot-blue-previous blot-blue" "docker create" && ! called "blot-green-previous" && ! called "docker stop --time 30 blot-green" && ! called "docker update" && running_now blot-blue && gone blot-blue-previous && running_now blot-green && serving container'
check "blue rolled back: the unit put back is the old image, the new one is removed first" \
  '[ "$(cat "$FAKE/image/blot-blue")" = img:old ] && before "docker rm -f blot-blue" "docker rename blot-blue-previous blot-blue"'

reset steady; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "checks fail after blue was replaced: blue put back, new one removed, green untouched" \
  '[ $RC != 0 ] && after_last "docker start blot-blue-previous" "docker stop" && called "docker rm -f blot-blue" && ! called "docker rm -f blot-blue-previous" && ! called "docker stop --time 30 blot-green" && ! called "blot-green-previous"'

reset steady; FAKE_START_FAILS=blot-green bluegreen
check "green fails after blue was replaced: green is put back, blue stays on the new image" \
  '[ $RC != 0 ] && called "docker rm -f blot-blue-previous" && called "docker start blot-green-previous" && running_now blot-green && gone blot-green-previous && [ "$(cat "$FAKE/image/blot-blue")" = img:2 ] && [ "$(cat "$FAKE/image/blot-green")" = img:old ]'

reset steady; FAKE_FAIL_AFTER_STOP=1 FAKE_START_FAILS=blot-blue-previous bluegreen
check "the old blue will not come back: the new, healthy one is kept and the failure is loud" \
  '[ $RC != 0 ] && mentions "did not come back healthy" && mentions "Keeping the new blot-blue" && ! called "docker rm -f blot-blue$" && running_now blot-blue'

reset steady; FAKE_UPDATE_FAILS=1 bluegreen
check "restart policy cannot be set: the new blue is not kept, the old one is put back, green untouched" \
  '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker stop --time 30 blot-green" && [ "$(cat "$FAKE/image/blot-blue")" = img:old ]'

reset steady; FAKE_RM_FAILS=blot-blue-previous bluegreen
check "the previous unit cannot be removed: fails loudly and rolls back to it" \
  '[ $RC != 0 ] && mentions "could not remove blot-blue-previous" && called "docker start blot-blue-previous" && [ "$(cat "$FAKE/image/blot-blue")" = img:old ]'

reset steady; FAKE_COMES_BACK=blot-blue bluegreen
check "old blue restarted by the health cron while draining: still removed, not left serving" \
  '[ $RC = 0 ] && called "docker rm -f blot-blue-previous" && ! running_now blot-blue-previous && running_now blot-blue'

reset steady; FAKE_REDIS_DOWN=1 bluegreen
check "Redis unreachable after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker rm -f blot-blue-previous"'

reset steady; FAKE_PURGE_FAIL=1 bluegreen
check "purge endpoint lost after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous"'

reset steady; FAKE_UPSTREAM_DOWN=8089 bluegreen
check "upstream unreachable: refused in preflight, before anything is touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop"'

reset steady; FAKE_STDOUT_LOGS=1 bluegreen
check "image that logs to stdout: refused before starting anything" '[ $RC != 0 ] && ! called "docker create"'

reset steady; FAKE_CONTAINER_CODE=502 bluegreen
check "site unhealthy before the deploy: not deployed" '[ $RC != 0 ] && ! called "docker create"'

reset steady; FAKE_LOCK_HELD=1 bluegreen
check "another deploy holds the lock: refused, nothing touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "already running"'

if [ "$(id -u)" != 0 ]; then # root ignores file modes
  reset steady; : > "$T/lock"; chmod 444 "$T/lock"; bluegreen
  check "an existing lock file the user cannot write is opened read-only: the deploy proceeds" '[ $RC = 0 ] && called "docker create" && ! mentions "cannot open the deploy lock"'
  chmod 644 "$T/lock"; rm -f "$T/lock"
fi

reset steady; bluegreen
check "TCP upstreams (the default): /run/blot is not mounted into the proxy" '[ $RC = 0 ] && ! called "/run/blot"'

reset steady; cp "$T/proxy.env" "$T/proxy.env.tcp"
printf 'PROXY_UPSTREAM_BLUE=unix:/run/blot/blue.sock\nPROXY_UPSTREAM_GREEN=unix:/run/blot/green.sock\nPROXY_UPSTREAM_YELLOW=unix:/run/blot/yellow.sock\n' >> "$T/proxy.env"
bluegreen; cp "$T/proxy.env.tcp" "$T/proxy.env"
check "unix: upstreams: /run/blot is bind-mounted and each socket is checked" '[ $RC = 0 ] && called "create.*--mount type=bind,source=/run/blot,target=/run/blot" && called "curl.*--unix-socket /run/blot/green.sock http://localhost/health"'

reset steady; bash "$DEPLOY/blue-green.sh" abc123 >"$T/out" 2>&1; RC=$?
check "a bare commit SHA is pulled from the proxy registry" '[ $RC = 0 ] && called "ghcr.io/blotcms/blot-proxy:abc123"'

echo "blue-green.sh: a unit is missing (a crash, an earlier failed deploy)"

reset steady; rm "$FAKE/running/blot-blue" "$FAKE/all/blot-blue"; bluegreen
check "blue missing: it is started first, beside green, then green is replaced; blue is not replaced again" \
  '[ $RC = 0 ] && before "docker start blot-blue" "docker stop --time 30 blot-green" && ! called "docker stop --time 30 blot-blue" && ! called "docker rename blot-blue" && running_now blot-blue && running_now blot-green && gone blot-green-previous'
check "blue missing: the started unit gets its restart policy and runs the new image" \
  'called "docker update --restart unless-stopped blot-blue" && [ "$(cat "$FAKE/image/blot-blue")" = img:2 ]'

reset steady; rm "$FAKE/running/blot-green" "$FAKE/all/blot-green"; bluegreen
check "green missing: it is started, then blue is replaced while green (healthy) carries the traffic" \
  '[ $RC = 0 ] && before "docker start blot-green" "docker stop --time 30 blot-blue" && ! called "docker stop --time 30 blot-green" && running_now blot-blue && running_now blot-green'

reset steady; rm "$FAKE/running/blot-blue" "$FAKE/all/blot-blue"; FAKE_UNHEALTHY=blot-blue bluegreen
check "the missing unit never becomes healthy: it is removed, the running one is never stopped" \
  '[ $RC != 0 ] && ! called "docker stop" && after_last "docker rm -f blot-blue" "docker start blot-blue" && gone blot-blue && running_now blot-green'

reset steady; : > "$FAKE/all/blot-blue-previous"; bluegreen
check "a stopped -previous left by a killed deploy, with its unit healthy: removed" '[ $RC = 0 ] && mentions "Removing blot-blue-previous" && gone blot-blue-previous'

reset steady; : > "$FAKE/all/blot-blue-previous"; rm "$FAKE/running/blot-blue"; bluegreen
check "a -previous and no running unit: refused, with the commands to put it back" \
  '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && mentions "docker rename blot-blue-previous blot-blue"'

echo "blue-green.sh: from the single legacy proxy (blot-proxy-blue or blot-proxy-green) to the two units"

reset legacy; bluegreen
check "legacy: both units start beside it and are checked; only then is the legacy proxy stopped and removed" \
  '[ $RC = 0 ] && before "docker start blot-blue" "docker start blot-green" && before "docker start blot-green" "docker stop --time 30 blot-proxy-blue" && before "docker stop --time 30 blot-proxy-blue" "docker rm -f blot-proxy-blue" && ! called "docker rename"'
check "legacy: both units are restartable BEFORE the legacy proxy is stopped" \
  'before "docker update --restart unless-stopped blot-blue" "docker stop" && before "docker update --restart unless-stopped blot-green" "docker stop"'
check "legacy: the units are what is left, on the new image, and :443 is served" \
  'running_now blot-blue && running_now blot-green && gone blot-proxy-blue && [ "$(cat "$FAKE/image/blot-green")" = img:2 ] && serving container'
check "legacy: the units know their names (PROXY_UNIT)" \
  'called "create .*--name blot-blue .*-e PROXY_UNIT=blue" && called "create .*--name blot-green .*-e PROXY_UNIT=green"'

reset legacy; rm "$FAKE/running/blot-proxy-blue" "$FAKE/all/blot-proxy-blue"; up blot-proxy-green; bluegreen
check "legacy: the green-named legacy proxy is handled the same way" \
  '[ $RC = 0 ] && called "docker stop --time 30 blot-proxy-green" && gone blot-proxy-green && running_now blot-blue && running_now blot-green'

reset legacy; FAKE_UNHEALTHY=blot-blue bluegreen
check "legacy: blue never healthy: nothing is stopped, the legacy proxy keeps serving, nothing is left behind" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker create --restart no --name blot-green" && gone blot-blue && running_now blot-proxy-blue && serving container'

reset legacy; FAKE_UNHEALTHY=blot-green bluegreen
check "legacy: green never healthy: blue is removed too, the legacy proxy is untouched" \
  '[ $RC != 0 ] && ! called "docker stop" && gone blot-blue && gone blot-green && running_now blot-proxy-blue'

reset legacy; FAKE_UPDATE_FAILS=1 bluegreen
check "legacy: restart policy cannot be set: the legacy proxy is never stopped, the units are removed" \
  '[ $RC != 0 ] && ! called "docker stop" && gone blot-blue && gone blot-green && running_now blot-proxy-blue'

reset legacy; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "legacy: checks fail after it was stopped: it is started again, both units removed, it is not removed" \
  '[ $RC != 0 ] && after_last "docker start blot-proxy-blue" "docker stop" && ! called "docker rm -f blot-proxy-blue" && gone blot-blue && gone blot-green && running_now blot-proxy-blue'

reset legacy; FAKE_FAIL_AFTER_STOP=1 FAKE_START_FAILS=blot-proxy-blue bluegreen
check "legacy: it will not come back: the units are kept (they may be all that serves) and the failure is loud" \
  '[ $RC != 0 ] && mentions "did not come back healthy" && running_now blot-blue && running_now blot-green'

reset legacy; FAKE_RM_FAILS=blot-proxy-blue bluegreen
check "legacy: it cannot be removed: fails loudly and rolls back to it, removing the units" \
  '[ $RC != 0 ] && mentions "could not remove blot-proxy-blue" && called "docker start blot-proxy-blue" && gone blot-blue && gone blot-green'

reset legacy; FAKE_COMES_BACK=blot-proxy-blue bluegreen
check "legacy: restarted by the health cron while draining: still removed" '[ $RC = 0 ] && called "docker rm -f blot-proxy-blue" && ! running_now blot-proxy-blue && running_now blot-blue'

reset legacy; up blot-blue; bluegreen
check "a legacy proxy and a unit running together: refused, nothing touched" \
  '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && mentions "running together"'

reset legacy; up blot-proxy-green; bluegreen
check "both legacy proxies running: refused, nothing touched" \
  '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "are both running"'

echo "blue-green.sh: a fresh start (nothing running)"

reset none; FAKE_UNIT_ENABLED=1 bluegreen
check "fresh start while the bare-metal unit is still enabled: refused" '[ $RC != 0 ] && ! called "docker create" && mentions "systemctl disable --now openresty"'

reset baremetal; bluegreen
check "bare-metal still serving and no container: refused, says how to hand over" '[ $RC != 0 ] && ! called "docker create" && mentions "systemctl disable --now openresty"'

reset none; bluegreen
check "fresh start: blue is checked and made permanent, then green is started the same way" \
  '[ $RC = 0 ] && ! called "docker stop" && before "docker start blot-blue" "docker update --restart unless-stopped blot-blue" && before "docker update --restart unless-stopped blot-blue" "docker create --restart no --name blot-green" && before "docker start blot-green" "docker update --restart unless-stopped blot-green" && running_now blot-blue && running_now blot-green && serving container'

reset none; FAKE_UNHEALTHY=blot-blue bluegreen
check "fresh start whose blue never becomes healthy: removed, nothing left, green never started" \
  '[ $RC != 0 ] && after_last "docker rm -f blot-blue" "docker start blot-blue" && ! called "docker update" && ! called "docker create --restart no --name blot-green" && gone blot-blue'

reset none; FAKE_UNHEALTHY=blot-green bluegreen
check "fresh start whose green never becomes healthy: green is removed, blue (already checked) keeps serving" \
  '[ $RC != 0 ] && gone blot-green && running_now blot-blue && called "docker update --restart unless-stopped blot-blue" && ! called "docker update --restart unless-stopped blot-green"'

reset none; FAKE_CONTAINER_CODE=502 bluegreen
check "fresh start whose site checks fail: removed, never made permanent" '[ $RC != 0 ] && gone blot-blue && ! called "docker update"'

echo "cache directories"

reset_in() { grep -q -- "run --rm --user 0 --entrypoint sh -v $1:/cache" "$FAKE/calls"; }
reset_of() { line "run --rm --user 0 --entrypoint sh -v $1:/cache"; }
mounted() { called "create .*-v $1:/var/cache/openresty"; }

reset steady; bluegreen
check "steady: nothing is emptied, the warm cache is kept, the disk cache directory is mounted" \
  '[ $RC = 0 ] && ! called "--entrypoint sh" && mounted "$T/disk-cache"'

reset steady; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "failed replacement after blue was stopped: the cache directory is not emptied (the other unit shares it)" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "--entrypoint sh"'

reset legacy; bluegreen
check "legacy transition: the cache directory is kept too" '[ $RC = 0 ] && ! called "--entrypoint sh" && mounted "$T/disk-cache"'

reset none; bluegreen
check "fresh start: the cache directory is emptied first by a container, in the background too, and mounted" \
  '[ $RC = 0 ] && [ "$(reset_of "$T/disk-cache")" -lt "$(line "docker create")" ] && mounted "$T/disk-cache" && called "docker run -d --rm --user 0 --entrypoint sh -v $T/disk-cache:/cache"'

reset none; FAKE_RESET_FAILS=1 bluegreen
check "fresh start whose cache directory cannot be emptied: refused before any unit exists" '[ $RC != 0 ] && ! called "docker create"'

reset steady; rmdir "$T/disk-cache"; bluegreen
check "the cache directory is missing: refused, with the command to create it" \
  '[ $RC != 0 ] && ! called "docker create" && mentions "sudo install -d -o 1000 -g 1000 $T/disk-cache"'
mkdir -p "$T/disk-cache"

echo "certificates on a fresh start"

reset none; FAKE_NO_CUSTOM_CERT=b.custom.test bluegreen
check "fresh start where a Redis domain gets no certificate: refused, listed, never made permanent" '[ $RC != 0 ] && mentions "b.custom.test" && mentions "1 of 2" && gone blot-blue && ! called "docker update"'

reset none; FAKE_NO_CUSTOM_CERT=b.custom.test PROXY_SKIP_CERT_SWEEP=1 bluegreen
check "fresh start with PROXY_SKIP_CERT_SWEEP=1: allowed, and says it skipped" '[ $RC = 0 ] && mentions "not checking custom-domain certificates"'

reset none; bluegreen
check "fresh start where every Redis domain gets a certificate: made permanent" '[ $RC = 0 ] && mentions "all 2 in Redis are being served" && called "docker update --restart unless-stopped blot-blue"'

reset none; FAKE_CUSTOM_DOMAINS="" bluegreen
check "fresh start with no custom domains in Redis: nothing to serve, allowed" '[ $RC = 0 ]'

reset none; FAKE_CUSTOM_FP_CONTAINER=A bluegreen
check "fresh start where custom domains get the wildcard (auto-ssl fallback): refused, never made permanent" '[ $RC != 0 ] && mentions "no certificate of its own" && mentions "2 of 2" && gone blot-blue && ! called "docker update"'

reset none; FAKE_NO_CUSTOM_CERT=b.custom.test FAKE_EXPIRED_DOMAINS=b.custom.test bluegreen
check "fresh start where the domain without a certificate has an expired one in Redis: allowed" '[ $RC = 0 ] && mentions "all 2 in Redis are being served"'

reset none; FAKE_REDIS_WILDCARD_PEM=redis-wildcard FAKE_SERVED_FP=R FAKE_CUSTOM_FP_CONTAINER=R bluegreen
check "fresh start where custom domains get the Redis wildcard: refused" '[ $RC != 0 ] && mentions "no certificate of its own" && mentions "2 of 2" && gone blot-blue && ! called "docker update"'

reset none; FAKE_SCAN_FAIL=1 bluegreen
check "fresh start where the Redis SCAN fails: refused, not mistaken for no custom domains" '[ $RC != 0 ] && mentions "SCAN failed" && ! called "docker update"'

reset none; FAKE_SCAN_ERROR_REPLY=1 bluegreen
check "fresh start where SCAN returns an error reply: refused" '[ $RC != 0 ] && mentions "SCAN failed" && ! called "docker update"'

echo
echo "old images"

reset steady; FAKE_IMAGES="img:1 img:2 img:0 other:1" bluegreen
check "deploy: removes the repository's other images, keeps the deployed one and other repositories" '[ $RC = 0 ] && called "docker rmi img:1" && called "docker rmi img:0" && ! called "docker rmi img:2" && ! called "docker rmi other:1" && mentions "Removed old image img:1"'

reset none; FAKE_IMAGES="img:1 img:2" bluegreen
check "fresh start: removes the old image too" '[ $RC = 0 ] && called "docker rmi img:1" && ! called "docker rmi img:2"'

reset steady; FAKE_IMAGES="img:1 img:2" FAKE_IMAGE_IN_USE="img:1" bluegreen
check "an image still in use is left alone, and the deploy still succeeds" '[ $RC = 0 ] && ! mentions "Removed old image img:1"'

reset steady; FAKE_IMAGES="img:1 img:2" FAKE_UNHEALTHY=blot-blue bluegreen
check "a failed deploy removes no images" '[ $RC != 0 ] && ! called "docker rmi"'

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
