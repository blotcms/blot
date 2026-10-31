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
  image) if [[ "$*" == *Labels* ]]; then [[ "${!#}" =~ :[0-9a-f]{40}$ ]] && echo unit; exit 0; fi   # the unit images are the ones tagged with a commit
    [ -z "${FAKE_NO_AIRLOCK_IMAGE:-}" ] || [[ "${!#}" != *blot-airlock:* ]] || exit 1
    if [[ "$*" == *"{{.Id}}"* ]]; then echo "${!#}"; fi; exit 0 ;;
  images) for i in ${FAKE_IMAGES-}; do [[ "$i" == "$2":* ]] && echo "$i"; done; exit 0 ;;
  rmi) [[ " ${FAKE_IMAGE_IN_USE:-} " != *" ${!#} "* ]]; exit ;;
  pull) [ -z "${FAKE_NO_AIRLOCK_IMAGE:-}" ] || [[ "${!#}" != *blot-airlock:* ]] || exit 1; exit 0 ;;
  network) echo 172.17.0.1 ;;
  ps) if [[ "$*" == *health=unhealthy* ]]; then printf '%s\n' ${FAKE_UNHEALTHY_LIST-}; exit 0; fi
    if [[ "$*" == *" -a "* ]]; then ls "$FAKE/all" 2>/dev/null; else ls "$R"; fi; exit 0 ;;
  run)
    # reset_cache_dir: the foreground container moves the entries aside, the
    # detached one deletes them
    if [[ "$*" == *"--entrypoint sh"* ]]; then
      [ -z "${FAKE_RESET_FAILS:-}" ] || exit 1
      exit 0
    fi
    if [[ " $* " == *" -d "* ]]; then n=$(name_arg "$@"); mkdir -p "$FAKE/image"; echo "${!#}" > "$FAKE/image/$n"; touch "$R/$n" "$FAKE/all/$n" 2>/dev/null || { mkdir -p "$FAKE/all"; touch "$R/$n" "$FAKE/all/$n"; }; exit 0; fi
    if [[ "$*" == *"openresty -t"* ]]; then [ -z "${FAKE_VALIDATE_FAIL:-}" ] || { echo "nginx: [emerg] bad"; exit 1; }; exit 0; fi
    if [[ "$*" == *"access_log"* ]]; then [ -z "${FAKE_STDOUT_LOGS:-}" ]; exit; fi ;;
  create) [ -z "${FAKE_CREATE_FAILS:-}" ] || exit 1; n=$(name_arg "$@"); mkdir -p "$FAKE/all" "$FAKE/image"; touch "$FAKE/all/$n"
    echo "${!#}" > "$FAKE/image/$n" ;;
  rename) mv "$R/$2" "$R/$3" 2>/dev/null; mv "$FAKE/all/$2" "$FAKE/all/$3" 2>/dev/null; mv "$FAKE/image/$2" "$FAKE/image/$3" 2>/dev/null; exit 0 ;;
  start)
    n="$2"; [ "$n" != "${FAKE_START_FAILS:-}" ] || exit 1
    touch "$R/$n"
    if [[ "$n" =~ ^blot-(blue|green)(-previous)?$ ]]; then
      if [ "$(cat "$FAKE/serving")" = baremetal ]; then rm -f "$R/$n"; else echo container > "$FAKE/serving"; fi
    fi ;;
  stop) n="${!#}"; rm -f "$R/$n"; touch "$FAKE/stopped"
    # the health cron docker-restarts a draining container that went unhealthy
    [ "$n" != "${FAKE_COMES_BACK:-}" ] || { touch "$R/$n"; exit 0; }
    [ -n "$(ls "$R" | grep -E '^blot-(blue|green)(-previous)?$')" ] || echo none > "$FAKE/serving" ;;
  rm) n="${!#}"; [ "$n" != "${FAKE_RM_FAILS:-}" ] || exit 1
    rm -f "$R/$n" "$FAKE/all/$n"
    [ -n "$(ls "$R" | grep -E '^blot-(blue|green)(-previous)?$')" ] || { [ "$(cat "$FAKE/serving")" != container ] || echo none > "$FAKE/serving"; } ;;
  update) [ -z "${FAKE_UPDATE_FAILS:-}" ] || exit 1 ;;
  logs) cat "$FAKE/dlogs/${!#}" 2>/dev/null ;;
  inspect) if [[ "$*" == *Labels* ]]; then [[ "$(cat "$FAKE/image/${!#}" 2>/dev/null)" =~ :[0-9a-f]{40}$ ]] && echo unit; exit 0; fi
    if [[ "$*" == *"State.Running"* ]]; then echo "${FAKE_HEALTH_OF_OTHER:-healthy}"; exit 0; fi
    if [[ "$*" == *"Health.Status"* ]]; then if [ "${!#}" = "${FAKE_AIRLOCK_UNHEALTHY:-}" ]; then echo unhealthy; else echo healthy; fi; exit 0; fi
    if [[ "$*" == *"{{.Image}}"* || "$*" == *"{{.Config.Image}}"* ]]; then cat "$FAKE/image/${!#}" 2>/dev/null; exit 0; fi
    cat "$FAKE/started/${!#}" 2>/dev/null ;;
  exec)
    # skip docker exec's own options (--user, -e ...) so $2 is the container again
    shift; while [[ "${1:-}" == -* ]]; do case "$1" in --user|-u|-e|-w) shift 2 ;; *) shift ;; esac; done
    set -- exec "$@"
    n="$2"
    if [[ "$*" == *verify-container* ]]; then [ -z "${FAKE_VERIFY_FAIL:-}" ] || { echo "FAIL fake check"; exit 1; }; echo "PASS fake"; exit 0; fi
    if [[ "$*" == *"--unix-socket"* ]]; then
      [ -e "$R/$n" ] && [ "$n" != "${FAKE_UNHEALTHY:-}" ] || exit 1
      if [[ "$*" == *-a.sock* && "$n" == "${FAKE_NODE_A_UNHEALTHY:-}" ]]; then exit 1; fi
      if [[ "$*" == *-b.sock* && "$n" == "${FAKE_NODE_B_UNHEALTHY:-}" ]]; then exit 1; fi
      exit 0
    fi
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
  if [ -n "${FAKE_SOCKET_DOWN:-}" ] && [[ "$args" == *"$FAKE_SOCKET_DOWN"* ]]; then printf 000; exit 7; fi
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
if [[ " $* " == *" ping "* ]]; then
  # common.sh's redis_reachable on a socket; FAKE_REDIS_DOWN is a stale socket file
  [ -z "${FAKE_REDIS_DOWN:-}" ] && echo PONG; exit 0
fi
if [[ " $* " == *" get blot:openresty:ssl:pem "* ]]; then echo "${FAKE_REDIS_WILDCARD_PEM:-}"; exit; fi
if [ "$*" = "-h 10.0.0.5 --raw" ] || [ "$*" = "-s /run/blot/redis/redis.sock --raw" ]; then
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
  PROXY_DEPLOY_SLEEP=true PROXY_HEALTH_TIMEOUT=1 PROXY_AIRLOCK_HEALTH_TIMEOUT=1 TMUX=fake # nap() is a no-op, so a refusal busy-waits out PROXY_HEALTH_TIMEOUT real seconds

# Units (#2119): the images, and the settings blue-green.sh reads for one. The
# numbers are the real ones from scripts/deploy/constants.js; only the host
# directories are this test's.
SHA_NEW=0123456789abcdef0123456789abcdef01234567
SHA_OLD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
UNIT_IMG="ghcr.io/blotcms/blot:$SHA_NEW"
UNIT_OLD="ghcr.io/blotcms/blot:$SHA_OLD"
AIRLOCK_NEW="ghcr.io/blotcms/blot-airlock:$SHA_NEW"
AIRLOCK_OLD="ghcr.io/blotcms/blot-airlock:$SHA_OLD"
mkdir -p "$T/data" "$T/tmp" "$T/run-blot"
node "$DEPLOY/../../scripts/deploy/unit-settings.js" > "$T/unit-settings.env"
printf 'DATA_DIRECTORY_ON_SERVER=%s\nTMP_DIRECTORY=%s\nSOCKET_DIRECTORY=%s\n' "$T/data" "$T/tmp" "$T/run-blot" >> "$T/unit-settings.env"
printf 'BLOT_HOST=blot.test\nBLOT_REDIS_HOST=10.0.0.5\nBLOT_PURGE_TOKEN=secret\nBLOT_REVERSE_PROXY_URLS=http://10.0.0.9:8077\n' > "$T/secrets.env"
export PROXY_UNIT_SETTINGS="$T/unit-settings.env" PROXY_SECRETS_ENV_FILE="$T/secrets.env"

pass=0; failed=0
ok() { pass=$((pass + 1)); echo "  ok   $*"; }
bad() { failed=$((failed + 1)); echo "  FAIL $*"; echo "----- calls"; sed 's/^/    /' "$FAKE/calls"; echo "----- output"; sed 's/^/    /' "$T/out"; }

# up <container> [image]: a container that is running (it was created from <image>)
up() { touch "$FAKE/running/$1" "$FAKE/all/$1"; echo "${2:-$UNIT_OLD}" > "$FAKE/image/$1"; }

# reset [baremetal|none|units]: fresh host state, `serving` says who owns :443
#   none      no unit running
#   baremetal a systemd unit
#   units     blot-blue and blot-green on an older image, each with its airlock
reset() {
  rm -rf "$FAKE"; mkdir -p "$FAKE/running" "$FAKE/all" "$FAKE/image"; : > "$FAKE/calls"; rm -f "$PROXY_LOG_DIR/error.log"
  unset "${!FAKE_@}" 2>/dev/null; export FAKE="$T/fake"
  case "$1" in
    none) echo none > "$FAKE/serving" ;;
    baremetal) touch "$FAKE/unit_active"; echo baremetal > "$FAKE/serving" ;;
    units) up blot-blue "$UNIT_OLD"; up blot-green "$UNIT_OLD"; up blot-blue-airlock "$AIRLOCK_OLD"; up blot-green-airlock "$AIRLOCK_OLD"
      echo container > "$FAKE/serving" ;;
    *) echo "reset: unknown state $1" >&2; exit 2 ;;
  esac
}
line() { grep -n -m1 -- "$1" "$FAKE/calls" | cut -d: -f1; }
called() { grep -q -- "$1" "$FAKE/calls"; }
before() { local a b; a=$(line "$1"); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
after_last() { local a b; a=$(grep -n -- "$1" "$FAKE/calls" | tail -1 | cut -d: -f1); b=$(line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -gt "$b" ]; }

bluegreen() { bash "$DEPLOY/blue-green.sh" "${1:-$UNIT_IMG}" >"$T/out" 2>&1; RC=$?; }
stopped_count() { grep -c "docker stop" "$FAKE/calls"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
serving() { [ "$(cat "$FAKE/serving")" = "$1" ]; }
mentions() { grep -q -- "$1" "$T/out"; }

echo "custom-domain certificates"

reset units; bluegreen
check "success: the custom-domain certificates are recorded and still match after each replacement" '[ $RC = 0 ] && mentions "2 of 2 in Redis are being served"'

reset units; FAKE_CUSTOM_DOMAINS="" bluegreen
check "no custom-domain certificate to compare: refused (unless skipped)" '[ $RC != 0 ] && ! called "docker create" && mentions "nothing to compare"'

reset units; FAKE_CUSTOM_DOMAINS="" PROXY_SKIP_CERT_SWEEP=1 bluegreen
check "PROXY_SKIP_CERT_SWEEP=1 skips the comparison" '[ $RC = 0 ] && mentions "not comparing"'

reset units; FAKE_CUSTOM_FP_AFTER_STOP=B bluegreen
check "a custom-domain certificate differs after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker rm -f blot-blue-previous" && mentions "custom-domain certificates"'

reset units; FAKE_CUSTOM_FP_AFTER_STOP=B FAKE_EXPIRED_DOMAINS="a.custom.test b.custom.test" bluegreen
check "a custom-domain certificate that has expired and is no longer served is not held against the deploy" '[ $RC = 0 ]'

# The replacement issues a new certificate for a domain whose stored one had
# expired, so the fingerprint changes. Expiry is judged before the swap: the
# fake Redis shows the fresh certificate afterwards, so a re-read then would
# call the domain unexpired.
reset units; FAKE_CUSTOM_FP_AFTER_STOP=B FAKE_EXPIRED_DOMAINS="a.custom.test b.custom.test" FAKE_EXPIRED_ONLY_AT_BASELINE=1 bluegreen
check "a certificate that expired and was reissued by the replacement is judged by its expiry before the replacement" '[ $RC = 0 ]'

echo "try-issuance.sh"

issue() { bash "$DEPLOY/try-issuance.sh" img:3 "$@" >"$T/out" 2>&1; RC=$?; }

reset units; issue throwaway.example.org
check "issues from staging in its own container, then removes the keys and the container" '[ $RC = 0 ] && called "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" && called "redis-cli -h 10.0.0.5 set domain:throwaway.example.org" && called "redis-cli -h 10.0.0.5 del domain:throwaway.example.org ssl:throwaway.example.org:latest" && called "docker rm -f blot-proxy-issuance" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'
check "the throwaway container uses no cache, log or auto-ssl volume and is not published beyond loopback" '! called "run -d.*/var/cache/openresty" && ! called "run -d.*/etc/resty-auto-ssl" && called "127.0.0.1:18444:443"'

reset units; bash "$DEPLOY/try-issuance.sh" "$SHA_NEW" throwaway.example.org >"$T/out" 2>&1; RC=$?
check "a bare commit SHA means the unit image, run with OpenResty alone (healthy without Node: only its health socket is asked)" '[ $RC = 0 ] && called "ghcr.io/blotcms/blot:$SHA_NEW" && called "--entrypoint /usr/local/bin/proxy-start"'

reset units; FAKE_NO_ISSUE=1 PROXY_ISSUANCE_ATTEMPTS=2 issue throwaway.example.org
check "no staging certificate: fails, and still cleans up" '[ $RC != 0 ] && mentions "no staging certificate" && called "redis-cli -h 10.0.0.5 del" && ! [ -e "$FAKE/running/blot-proxy-issuance" ]'

reset units; FAKE_KEY_EXISTS=1 issue real-customer.example.org
check "a domain Redis already knows: refused, and its keys are never deleted" '[ $RC != 0 ] && ! called "docker run" && ! called "redis-cli.* del" && ! called "redis-cli.* set" && mentions "not a throwaway"'

reset units; issue staging.blot.test
check "a domain under the site's own: refused" '[ $RC != 0 ] && ! called "docker run" && mentions "separate throwaway"'

echo "PROXY_ACME_CA"

echo "PROXY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset units; bluegreen
check "a staging ACME directory in proxy.env: refused before anything runs" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
reset units; PROXY_ALLOW_ACME_CA=1 bluegreen
check "PROXY_ALLOW_ACME_CA=1 overrides it" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_ACME_CA=https://acme-v02.api.letsencrypt.org/directory" >> "$T/proxy.env"
reset units; bluegreen
check "the production ACME directory is accepted" '[ $RC = 0 ]'
sed -i.bak '/^PROXY_ACME_CA=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"

echo "PROXY_ACME_CA=" >> "$T/proxy.env"
reset units; bluegreen
check "an empty PROXY_ACME_CA in proxy.env: refused (it would override the default with nothing)" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_ACME_CA"'
sed -i.bak '/^PROXY_ACME_CA=$/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"
echo "PROXY_RESOLVER=''" >> "$T/proxy.env"
reset units; bluegreen
check "any other empty PROXY_* setting is refused too" '[ $RC != 0 ] && ! called "docker create" && mentions "PROXY_RESOLVER"'
sed -i.bak '/^PROXY_RESOLVER=/d' "$T/proxy.env"; rm -f "$T/proxy.env.bak"


echo "blue-green.sh: steady state (blot-blue and blot-green running)"

running_now() { [ -e "$FAKE/running/$1" ]; }
gone() { ! [ -e "$FAKE/all/$1" ]; }
set_image() { echo "$2" > "$FAKE/image/$1"; }

reset units; bluegreen
check "success: blue is stopped, kept as -previous, replaced, and only then removed" \
  '[ $RC = 0 ] && before "docker stop --time 40 blot-blue" "docker rename blot-blue blot-blue-previous" && before "docker rename blot-blue blot-blue-previous" "docker create --restart no --name blot-blue" && before "docker start blot-blue" "docker rm -f blot-blue-previous"'
check "success: blue is finished before green is touched, and green goes the same way" \
  'before "docker rm -f blot-blue-previous" "docker stop --time 40 blot-green" && before "docker rename blot-green blot-green-previous" "docker create --restart no --name blot-green" && called "docker rm -f blot-green-previous"'
check "success: each new unit gets its restart policy before its previous one is removed" \
  'before "docker update --restart unless-stopped blot-blue" "docker rm -f blot-blue-previous" && before "docker update --restart unless-stopped blot-green" "docker rm -f blot-green-previous"'
check "success: both units run the new image, nothing else is left, :443 is served" \
  'running_now blot-blue && running_now blot-green && gone blot-blue-previous && gone blot-green-previous && [ "$(cat "$FAKE/image/blot-blue")" = $UNIT_IMG ] && [ "$(cat "$FAKE/image/blot-green")" = $UNIT_IMG ] && serving container'
check "success: the units are told which one they are (PROXY_UNIT), and get the fd ulimit and the CDN static mount" \
  'called "docker create --restart no --name blot-blue --network host --cap-add SYS_NICE --ulimit nofile=65536:65536" && called "create .*--name blot-blue .*-e PROXY_UNIT=blue" && called "create .*--name blot-green .*-e PROXY_UNIT=green" && called "-v /var/www/blot/app/blog/static:/var/www/blot/app/blog/static:ro"'
check "success: exactly two stops, blue's and then green's, so one unit is always up" \
  '[ "$(grep -c "docker stop" "$FAKE/calls")" = 2 ]'

reset units; set_image blot-blue $UNIT_IMG; set_image blot-green $UNIT_IMG; bluegreen
check "a re-run with the image both units already run: nothing is stopped, renamed or created" \
  '[ $RC = 0 ] && ! called "docker stop" && ! called "docker rename" && ! called "docker create" && mentions "nothing to do"'

reset units; set_image blot-blue $UNIT_IMG; bluegreen
check "blue already on the image (a deploy that stopped after blue): only green is replaced" \
  '[ $RC = 0 ] && ! called "docker stop --time 40 blot-blue" && called "docker stop --time 40 blot-green" && [ "$(cat "$FAKE/image/blot-green")" = $UNIT_IMG ]'

reset units; set_image blot-blue $UNIT_IMG; set_image blot-green $UNIT_IMG; FAKE_UNHEALTHY=blot-green bluegreen
check "an unhealthy unit is replaced even on the right image (here the replacement is unhealthy too: rolled back); the healthy one is not touched" \
  '[ $RC != 0 ] && called "docker stop --time 40 blot-green" && ! called "docker stop --time 40 blot-blue"'

reset units; FAKE_UNHEALTHY=blot-green bluegreen
check "green unhealthy: blue is not stopped (it would leave no healthy proxy), nothing is touched" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker rename" && ! called "docker create" && mentions "refusing to stop blot-blue"'

reset units; FAKE_UNHEALTHY=blot-blue bluegreen
check "blue never becomes healthy: blue is rolled back from -previous, green is never touched" \
  '[ $RC != 0 ] && called "docker start blot-blue-previous" && after_last "docker rename blot-blue-previous blot-blue" "docker create" && ! called "blot-green-previous" && ! called "docker stop --time 40 blot-green" && ! called "docker update" && running_now blot-blue && gone blot-blue-previous && running_now blot-green && serving container'
check "blue rolled back: the unit put back is the old image, the new one is removed first" \
  '[ "$(cat "$FAKE/image/blot-blue")" = $UNIT_OLD ] && before "docker rm -f blot-blue$" "docker rename blot-blue-previous blot-blue"'

reset units; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "checks fail after blue was replaced: blue put back, new one removed, green untouched" \
  '[ $RC != 0 ] && after_last "docker start blot-blue-previous" "docker stop" && called "docker rm -f blot-blue" && ! called "docker rm -f blot-blue-previous" && ! called "docker stop --time 40 blot-green" && ! called "blot-green-previous"'

reset units; FAKE_START_FAILS=blot-green bluegreen
check "green fails after blue was replaced: green is put back, blue stays on the new image" \
  '[ $RC != 0 ] && called "docker rm -f blot-blue-previous" && called "docker start blot-green-previous" && running_now blot-green && gone blot-green-previous && [ "$(cat "$FAKE/image/blot-blue")" = $UNIT_IMG ] && [ "$(cat "$FAKE/image/blot-green")" = $UNIT_OLD ]'

reset units; FAKE_FAIL_AFTER_STOP=1 FAKE_START_FAILS=blot-blue-previous bluegreen
check "the old blue will not come back: the new one is already removed (they would share sockets), the old one is left stopped under its name and the failure is loud" \
  '[ $RC != 0 ] && mentions "did not come back healthy" && mentions "Leaving it stopped as blot-blue" && ! running_now blot-blue && ! gone blot-blue'

reset units; FAKE_UPDATE_FAILS=1 bluegreen
check "restart policy cannot be set: the new blue is not kept, the old one is put back, green untouched" \
  '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker stop --time 40 blot-green" && [ "$(cat "$FAKE/image/blot-blue")" = $UNIT_OLD ]'

reset units; FAKE_RM_FAILS=blot-blue-previous bluegreen
check "the previous unit cannot be removed: fails loudly and rolls back to it" \
  '[ $RC != 0 ] && mentions "could not remove blot-blue-previous" && called "docker start blot-blue-previous" && [ "$(cat "$FAKE/image/blot-blue")" = $UNIT_OLD ]'

reset units; FAKE_COMES_BACK=blot-blue bluegreen
check "old blue restarted by the health cron while draining: still removed, not left serving" \
  '[ $RC = 0 ] && called "docker rm -f blot-blue-previous" && ! running_now blot-blue-previous && running_now blot-blue'

reset units; FAKE_REDIS_DOWN=1 bluegreen
check "Redis unreachable after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "docker rm -f blot-blue-previous"'

reset units; FAKE_PURGE_FAIL=1 bluegreen
check "purge endpoint lost after blue was replaced: rolled back" '[ $RC != 0 ] && called "docker start blot-blue-previous"'

reset units; FAKE_SOCKET_DOWN=green-b.sock bluegreen
check "a running unit's Node socket does not answer: refused in preflight, before anything is touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && mentions "not healthy"'

reset units; FAKE_STDOUT_LOGS=1 bluegreen
check "image that logs to stdout: refused before starting anything" '[ $RC != 0 ] && ! called "docker create"'

reset units; FAKE_CONTAINER_CODE=502 bluegreen
check "site unhealthy before the deploy: not deployed" '[ $RC != 0 ] && ! called "docker create"'

reset units; FAKE_LOCK_HELD=1 bluegreen
check "another deploy holds the lock: refused, nothing touched" '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && ! called "docker rm" && mentions "already running"'

if [ "$(id -u)" != 0 ]; then # root ignores file modes
  reset units; : > "$T/lock"; chmod 444 "$T/lock"; bluegreen
  check "an existing lock file the user cannot write is opened read-only: the deploy proceeds" '[ $RC = 0 ] && called "docker create" && ! mentions "cannot open the deploy lock"'
  chmod 644 "$T/lock"; rm -f "$T/lock"
fi

echo "blue-green.sh: a unit is missing (a crash, an earlier failed deploy)"

reset units; rm "$FAKE/running/blot-blue" "$FAKE/all/blot-blue"; bluegreen
check "blue missing: it is started first, beside green, then green is replaced; blue is not replaced again" \
  '[ $RC = 0 ] && before "docker start blot-blue" "docker stop --time 40 blot-green" && ! called "docker stop --time 40 blot-blue" && ! called "docker rename blot-blue" && running_now blot-blue && running_now blot-green && gone blot-green-previous'
check "blue missing: the started unit gets its restart policy and runs the new image" \
  'called "docker update --restart unless-stopped blot-blue" && [ "$(cat "$FAKE/image/blot-blue")" = $UNIT_IMG ]'

reset units; rm "$FAKE/running/blot-green" "$FAKE/all/blot-green"; bluegreen
check "green missing: it is started, then blue is replaced while green (healthy) carries the traffic" \
  '[ $RC = 0 ] && before "docker start blot-green" "docker stop --time 40 blot-blue" && ! called "docker stop --time 40 blot-green" && running_now blot-blue && running_now blot-green'

reset units; rm "$FAKE/running/blot-blue" "$FAKE/all/blot-blue"; FAKE_UNHEALTHY=blot-blue bluegreen
check "the missing unit never becomes healthy: it is removed, the running one is never stopped" \
  '[ $RC != 0 ] && ! called "docker stop" && after_last "docker rm -f blot-blue" "docker start blot-blue" && gone blot-blue && running_now blot-green'

reset units; : > "$FAKE/all/blot-blue-previous"; bluegreen
check "a stopped -previous left by a killed deploy, with its unit healthy: removed" '[ $RC = 0 ] && mentions "Removing blot-blue-previous" && gone blot-blue-previous'

reset units; : > "$FAKE/all/blot-blue-previous"; rm "$FAKE/running/blot-blue"; bluegreen
check "a -previous and no running unit: refused, with the commands to put it back" \
  '[ $RC != 0 ] && ! called "docker create" && ! called "docker stop" && mentions "docker rename blot-blue-previous blot-blue"'

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

reset units; bluegreen
check "steady: nothing is emptied, the warm cache is kept, the disk cache directory is mounted" \
  '[ $RC = 0 ] && ! called "--entrypoint sh" && mounted "$T/disk-cache"'

reset units; FAKE_FAIL_AFTER_STOP=1 bluegreen
check "failed replacement after blue was stopped: the cache directory is not emptied (the other unit shares it)" '[ $RC != 0 ] && called "docker start blot-blue-previous" && ! called "--entrypoint sh"'

reset none; bluegreen
check "fresh start: the cache directory is emptied first by a container, in the background too, and mounted" \
  '[ $RC = 0 ] && [ "$(reset_of "$T/disk-cache")" -lt "$(line "docker create")" ] && mounted "$T/disk-cache" && called "docker run -d --rm --user 0 --entrypoint sh -v $T/disk-cache:/cache"'

reset none; FAKE_RESET_FAILS=1 bluegreen
check "fresh start whose cache directory cannot be emptied: refused before any unit exists" '[ $RC != 0 ] && ! called "docker create"'

reset units; rmdir "$T/disk-cache"; bluegreen
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

reset units; FAKE_IMAGES="ghcr.io/blotcms/blot:old1 $UNIT_IMG ghcr.io/blotcms/blot:old0 other:1" bluegreen
check "deploy: removes the repository's other images, keeps the deployed one and other repositories" '[ $RC = 0 ] && called "docker rmi ghcr.io/blotcms/blot:old1" && called "docker rmi ghcr.io/blotcms/blot:old0" && ! called "docker rmi $UNIT_IMG" && ! called "docker rmi other:1" && mentions "Removed old image ghcr.io/blotcms/blot:old1"'

reset none; FAKE_IMAGES="ghcr.io/blotcms/blot:old1 $UNIT_IMG" bluegreen
check "fresh start: removes the old image too" '[ $RC = 0 ] && called "docker rmi ghcr.io/blotcms/blot:old1" && ! called "docker rmi $UNIT_IMG"'

reset units; FAKE_IMAGES="ghcr.io/blotcms/blot:old1 $UNIT_IMG" FAKE_IMAGE_IN_USE="ghcr.io/blotcms/blot:old1" bluegreen
check "an image still in use is left alone, and the deploy still succeeds" '[ $RC = 0 ] && ! mentions "Removed old image ghcr.io/blotcms/blot:old1"'

reset units; FAKE_IMAGES="ghcr.io/blotcms/blot:old1 $UNIT_IMG" FAKE_UNHEALTHY=blot-blue bluegreen
check "a failed deploy removes no images" '[ $RC != 0 ] && ! called "docker rmi"'

echo "units (#2119)"

reset units; bluegreen
check "blue's airlock, then blue is replaced, checked and verified, all before green is touched" \
  '[ $RC = 0 ] && before "docker run -d --restart unless-stopped --name blot-blue-airlock" "docker create --restart no --name blot-blue" && before "docker create --restart no --name blot-blue" "verify-container" && before "verify-container" "docker stop --time 40 blot-green" && before "docker stop --time 40 blot-green" "docker run -d --restart unless-stopped --name blot-green-airlock"'
check "both units and their airlocks run, the units on the new image, and blue was verified once" \
  'running_now blot-blue && running_now blot-green && running_now blot-blue-airlock && running_now blot-green-airlock && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_IMG" ] && [ "$(cat "$FAKE/image/blot-green")" = "$UNIT_IMG" ] && [ "$(grep -c verify-container "$FAKE/calls")" = 1 ] && called "exec --user 1000:1000 -e HOME=/home/node blot-blue node /usr/src/app/scripts/deploy/verify-container/index.js $SHA_NEW"'
check "a unit gets both env files (secrets.env first), its name, sockets, memory, heaps, release and mounts" \
  'called "create --restart no --name blot-blue --network host --cap-add SYS_NICE --ulimit nofile=65536:65536 --stop-timeout 40" && called "create .*--env-file $T/secrets.env --env-file $T/proxy.env -e BLOT_UNIT=blue -e PROXY_UNIT=blue -e PROXY_UPSTREAM_MODE=unit" && called "create .*-e BLOT_SOCKET=$T/run-blot/blue-a.sock -e BLOT_WORKER_SOCKET=$T/run-blot/blue-b.sock" && called "create .*--memory 3840m --cpus 4 --cpu-shares 2048" && called "create .*-e BLOT_RELEASE_ID=$SHA_NEW" && called "create .*-e NODE_OPTIONS=--max-old-space-size=1800 --report-on-fatalerror --report-directory=/usr/src/app/data/node-reports/blot-blue" && called "create .*-e BLOT_WORKER_MAX_OLD_SPACE_SIZE=750" && called "create .*bind-propagation=rslave" && called "create .*source=$T/tmp,target=$T/tmp" && called "create .*-e BLOT_TMP_DIRECTORY=$T/tmp"'
check "no port is published and the unit is on the host network, not blotnet" \
  '! called "create .* -p " && ! called "create .*blotnet" && called "create .*--network host"'
check "each unit reaches its own airlock on 127.0.0.1, which publishes on loopback only" \
  'called "create .*--name blot-blue .*-e BLOT_AIRLOCK_BROWSER_URL=http://127.0.0.1:19222 -e BLOT_AIRLOCK_PROXY_URL=http://127.0.0.1:18888" && called "create .*--name blot-green .*-e BLOT_AIRLOCK_BROWSER_URL=http://127.0.0.1:19223 -e BLOT_AIRLOCK_PROXY_URL=http://127.0.0.1:18889" && called "run -d .*--name blot-blue-airlock --network blotnet -p 127.0.0.1:19222:9222 -p 127.0.0.1:18888:8888 --cap-add=NET_ADMIN" && called "run -d .*--name blot-green-airlock --network blotnet -p 127.0.0.1:19223:9222 -p 127.0.0.1:18889:8888"'

reset units; FAKE_NODE_B_UNHEALTHY=blot-blue bluegreen
check "node-b never healthy in the new blue: rolled back, green untouched" \
  '[ $RC != 0 ] && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_OLD" ] && running_now blot-blue && ! called "docker stop --time 40 blot-green"'

reset units; FAKE_AIRLOCK_UNHEALTHY=blot-blue-airlock bluegreen
check "blue's airlock does not come up: the unit is not created, blue is put back, green untouched" \
  '[ $RC != 0 ] && mentions "airlock for blot-blue did not come up" && ! called "docker create --restart no --name blot-blue" && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_OLD" ] && ! called "docker stop --time 40 blot-green"'

reset units; bluegreen; : > "$FAKE/calls"
bluegreen
check "run again: nothing more is stopped, created or started" \
  '[ $RC = 0 ] && [ "$(stopped_count)" = 0 ] && ! called "docker create" && mentions "nothing to do"'

reset units; bluegreen abc123
check "an image without the unit label (here a bare tag, which resolves to the unit registry): refused before anything is touched" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker create" && ! called "docker run -d" && mentions "not a unit image"'

reset units; bluegreen proxy-only:1
check "a proxy-only image from another repository: refused the same way" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker create" && mentions "not a unit image"'

reset units; printf 'BLOT_HOST=elsewhere.test\n' >> "$T/secrets.env"; bluegreen
sed -i.bak '/^BLOT_HOST=elsewhere.test$/d' "$T/secrets.env"; rm -f "$T/secrets.env.bak"
check "a key set to different values in secrets.env and proxy.env: refused before anything is touched" \
  '[ $RC != 0 ] && ! called "docker stop" && ! called "docker create" && mentions "different values for: BLOT_HOST"'

reset units; rmdir "$T/run-blot"; bluegreen; mkdir -p "$T/run-blot"
check "the socket directory missing on the host: refused before anything is touched" \
  '[ $RC != 0 ] && ! called "docker stop" && mentions "does not exist on this host"'

echo "units: steady deploys"

reset units; bluegreen
check "steady: blue then green, each with its airlock replaced first, blue verified, exactly two stops, no old containers to stop" \
  '[ $RC = 0 ] && before "docker rm -f blot-blue-airlock" "docker create --restart no --name blot-blue" && before "verify-container" "docker stop --time 40 blot-green" && [ "$(stopped_count)" = 2 ] && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_IMG" ] && [ "$(cat "$FAKE/image/blot-green")" = "$UNIT_IMG" ] && [ "$(cat "$FAKE/image/blot-blue-airlock")" = "$AIRLOCK_NEW" ]'

reset units; up blot-blue "$UNIT_IMG"; up blot-green "$UNIT_IMG"; up blot-blue-airlock "$AIRLOCK_NEW"; up blot-green-airlock "$AIRLOCK_NEW"; bluegreen
check "steady, same image already deployed: nothing is stopped, created or replaced" \
  '[ $RC = 0 ] && [ "$(stopped_count)" = 0 ] && ! called "docker create" && ! called "docker run -d" && mentions "nothing to do"'

reset units; up blot-blue "$UNIT_IMG"; up blot-green "$UNIT_IMG"; bluegreen
check "steady, the units are current but their airlocks are not: the airlocks are replaced, the units left alone" \
  '[ $RC = 0 ] && [ "$(stopped_count)" = 0 ] && ! called "docker create" && [ "$(cat "$FAKE/image/blot-blue-airlock")" = "$AIRLOCK_NEW" ] && [ "$(cat "$FAKE/image/blot-green-airlock")" = "$AIRLOCK_NEW" ]'

reset units; FAKE_IMAGES="ghcr.io/blotcms/blot-airlock:$SHA_OLD ghcr.io/blotcms/blot-airlock:$SHA_NEW" bluegreen
check "steady: superseded airlock images are removed, the one in use is kept" \
  '[ $RC = 0 ] && called "docker rmi ghcr.io/blotcms/blot-airlock:$SHA_OLD" && ! called "docker rmi ghcr.io/blotcms/blot-airlock:$SHA_NEW"'

reset units; FAKE_NODE_A_UNHEALTHY=blot-blue bluegreen
check "steady, node-a of the new blue never healthy: the new unit is removed BEFORE the old one starts (they share sockets), green untouched" \
  '[ $RC != 0 ] && before "docker rm -f blot-blue$" "docker start blot-blue-previous" && called "docker start blot-blue-previous" && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_OLD" ] && ! called "docker stop --time 40 blot-green"'

reset units; FAKE_NODE_B_UNHEALTHY=blot-green bluegreen
check "steady, node-b of green is down: blue is not stopped, a unit counts as healthy only with node-a and node-b" \
  '[ $RC != 0 ] && ! called "docker stop" && mentions "refusing to stop blot-blue"'

reset units; FAKE_VERIFY_FAIL=1 bluegreen
check "steady, verify-container fails on blue: rolled back, green untouched, the airlock stays on the new image" \
  '[ $RC != 0 ] && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_OLD" ] && ! called "docker stop --time 40 blot-green"'

reset units; FAKE_NO_AIRLOCK_IMAGE=1 bluegreen
check "steady, no airlock image for the commit: the airlocks keep the image they run and the units are still replaced" \
  '[ $RC = 0 ] && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_IMG" ]'

reset units; FAKE_PURGE_FAIL=1 bluegreen
check "steady, the purge endpoint is not reachable from the new blue: rolled back" '[ $RC != 0 ] && [ "$(cat "$FAKE/image/blot-blue")" = "$UNIT_OLD" ]'

echo "Redis over a Unix socket (PROXY_REDIS_HOST=unix:...)"

SOCK=/run/blot/redis/redis.sock
sed -i.bak "s|^PROXY_REDIS_HOST=.*|PROXY_REDIS_HOST=unix:$SOCK|" "$T/proxy.env"; rm -f "$T/proxy.env.bak"
sed -i.bak "s|^BLOT_REDIS_HOST=.*|BLOT_REDIS_SOCKET=$SOCK|" "$T/secrets.env"; rm -f "$T/secrets.env.bak"

reset units; bluegreen
check "a unit deploy with both settings (secrets.env and proxy.env name different keys): runs, Redis is reached with -s and the path without unix:" \
  '[ $RC = 0 ] && ! mentions "different values" && ! called "redis-cli -h"'
reset units; FAKE_REDIS_DOWN=1 bluegreen
check "a stale socket (the file is there, nothing answers): fails, and says which socket" \
  '[ $RC != 0 ] && called "docker start blot-blue-previous" && mentions "does not answer on its socket $SOCK"'

reset units; issue throwaway.example.org
check "try-issuance: redis-cli gets -s and the bare path" \
  '[ $RC = 0 ] && called "redis-cli -s $SOCK set domain:throwaway.example.org" && called "redis-cli -s $SOCK del domain:throwaway.example.org" && ! called "redis-cli -h"'
check "try-issuance: the socket directory (only) is mounted into its bridge-network container" \
  'called "run -d.*--mount type=bind,source=/run/blot/redis,target=/run/blot/redis " && ! called "source=/run/blot,"'

sed -i.bak "s|^PROXY_REDIS_HOST=.*|PROXY_REDIS_HOST=10.0.0.5|" "$T/proxy.env"; rm -f "$T/proxy.env.bak"
sed -i.bak "s|^BLOT_REDIS_SOCKET=.*|BLOT_REDIS_HOST=10.0.0.5|" "$T/secrets.env"; rm -f "$T/secrets.env.bak"
reset units; issue throwaway.example.org
check "try-issuance on TCP: no Redis mount" '[ $RC = 0 ] && ! called "run -d.*/run/blot/redis"'

echo "check_docker_health.sh"

health() { PROXY_DEPLOY_LOCK="$T/lock" bash "$DEPLOY/../../config/host/scripts/check_docker_health.sh" >"$T/out" 2>&1; RC=$?; }

reset units; FAKE_UNHEALTHY_LIST="blot-blue blot-green" FAKE_HEALTH_OF_OTHER=unhealthy health
check "both units unhealthy: only blue is restarted" '[ $RC = 0 ] && called "docker restart blot-blue" && ! called "docker restart blot-green"'

reset units; FAKE_UNHEALTHY_LIST="blot-green" FAKE_HEALTH_OF_OTHER=healthy health
check "one unit unhealthy, the other healthy: it is restarted" 'called "docker restart blot-green"'

reset units; FAKE_UNHEALTHY_LIST="blot-green" FAKE_HEALTH_OF_OTHER=starting health
check "one unit unhealthy, the other still starting: it is left alone" '! called "docker restart" && mentions "Not restarting blot-green"'

reset units; : > "$T/lock"; FAKE_LOCK_HELD=1 FAKE_UNHEALTHY_LIST="blot-blue blot-blue-previous blot-blue-airlock blot-neutral" health; rm -f "$T/lock"
check "a deploy holds the lock: the units and -previous are left alone, the airlock and old Node containers are not" \
  '! called "docker restart blot-blue$" && ! called "docker restart blot-blue-previous" && called "docker restart blot-blue-airlock" && called "docker restart blot-neutral"'

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
