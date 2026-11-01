#!/bin/bash
# Runs promote.sh against Redis containers: old (6.2.12, the production
# version) and new (the newest 6.2), plus an "app" container with clients
# writing to the old host. ssh becomes docker exec; sudo is a pass-through
# (everything runs as root here); ip route get is real, inside the containers.
#
# Checks: the dry run changes nothing; a FAILOVER that cannot complete leaves
# the old host the master; the promotion waits for a held folder lock, loses
# no acknowledged write under load and moves the active marker; a new host
# that bootstrap.sh did not set up is refused; the printed rollback command
# moves everything back; a marker that cannot be written exits with an error
# naming the command to run by hand; when the ssh session running the
# FAILOVER dies, the promotion asks the old host how it ended: it carries on
# if the FAILOVER completed, stops with the old host still the master if it
# never started, and stops without touching the new host if the old host
# cannot be asked.
#
# Needs docker and perl. Usage: config/redis/tests/promote.sh (works on a Mac
# with bash 3.2 too, which checks promote.sh runs there).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROMOTE=$(dirname "$HERE")/promote.sh
PREFIX=blot-promote-test
NET=$PREFIX-net
OLD=$PREFIX-old
NEW=$PREFIX-new
APP=$PREFIX-app
TMP=$(mktemp -d)
FAILED=0

cleanup() {
  docker rm -f "$OLD" "$NEW" "$APP" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup
mkdir -p "$TMP/bin"

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then ok "$what"; else fail "$what"; fi
}
cli() { local c=$1; shift; docker exec "$c" redis6-cli "$@" | tr -d '\r'; }
role() { cli "$1" INFO replication | awk -F: '$1 == "role" {print $2}'; }
marked() { docker exec "$1" test -e /etc/blot-redis/active; }

echo "# Building the test images"
for version in 6.2.12 6.2; do
  docker build -q -t "$PREFIX:$version" - > /dev/null << EOF
FROM redis:$version-alpine
RUN apk add --no-cache bash coreutils iproute2 > /dev/null && ln -s /usr/local/bin/redis-cli /usr/local/bin/redis6-cli
# sudo -n <command>: everything runs as root here.
RUN printf '#!/bin/sh\n[ "\$1" = -n ] && shift\nexec "\$@"\n' > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo
EOF
done

docker network create "$NET" > /dev/null
run() { docker run -d --name "$1" --network "$NET" "$PREFIX:$2" redis-server --save '' > /dev/null; }
run "$OLD" 6.2.12
run "$NEW" 6.2
run "$APP" 6.2
addr() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
OLD_IP=$(addr "$OLD"); NEW_IP=$(addr "$NEW")
echo "# old $OLD_IP, new $NEW_IP"

# ssh <options> <host> <command>: docker exec in the container named <host>.
# Fault injection for the failure cases: a hook is a file in $STUB_HOOKS that
# a test creates just before the promotion it breaks, and that fires once
# (except "down", which the test removes).
#   session  mode before|after|after-down: the first "bash -s" session that
#            runs FAILOVER TO dies with status 137 and no output, just before
#            the FAILOVER is sent or just after Redis accepted it (after-down
#            also makes every later ssh to that host fail, like a lost host).
#   marker   host name: "touch /etc/blot-redis/active" on that host fails.
cat > "$TMP/bin/ssh" << 'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    -O) exit 0 ;;
    -o | -i | -p | -l) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host=$1
shift
H=${STUB_HOOKS:-/nonexistent}
if [ -f "$H/down" ] && [ "$host" = "$(cat "$H/down")" ]; then
  echo "ssh: connect to host $host: Connection refused" >&2
  exit 255
fi
if [ -f "$H/marker" ] && [ "$host" = "$(cat "$H/marker")" ]; then
  case "$*" in
    *"touch /etc/blot-redis/active"*)
      rm -f "$H/marker"
      echo "touch: cannot touch '/etc/blot-redis/active': Read-only file system" >&2
      exit 1 ;;
  esac
fi
if [ -f "$H/session" ] && [ "$*" = "bash -s" ]; then
  script=$(cat)
  case "$script" in
    *"FAILOVER TO"*)
      mode=$(cat "$H/session")
      rm -f "$H/session"
      case "$mode" in
        before) script=$(printf '%s\n' "$script" | awk '/^reply=.*FAILOVER TO/ {print "exit 137"} {print}') ;;
        *) script=$(printf '%s\n' "$script" | awk '{print} /^reply=.*FAILOVER TO/ {print "exit 137"}') ;;
      esac
      printf '%s\n' "$script" | docker exec -i "$host" sh -c "$*"
      status=$?
      [ "$mode" != after-down ] || echo "$host" > "$H/down"
      exit $status ;;
  esac
  printf '%s\n' "$script" | docker exec -i "$host" sh -c "$*"
  exit
fi
exec docker exec -i "$host" sh -c "$*"
EOF
chmod +x "$TMP/bin/ssh"
mkdir -p "$TMP/hooks"
export PATH="$TMP/bin:$PATH" STUB_HOOKS="$TMP/hooks"

# Production as it is: both hosts bootstrapped (the old one so that a rollback
# can go back to it), the old one marked active, and the new host replicating
# from the old host's own address.
for c in "$OLD" "$NEW"; do
  docker exec "$c" sh -c 'mkdir -p /etc/blot-redis /etc/cron.d && touch /etc/cron.d/blot-redis && printf "#!/bin/sh\n" > /usr/local/bin/backup.sh && chmod +x /usr/local/bin/backup.sh'
done
docker exec "$OLD" touch /etc/blot-redis/active
cli "$OLD" DEBUG POPULATE 200000 key 100 > /dev/null
cli "$OLD" SET ssl:example.com:latest cert > /dev/null
cli "$NEW" REPLICAOF "$OLD_IP" 6379 > /dev/null
for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done

promote() { "$PROMOTE" --yes --timeout-ms 1000 --lock-wait 5 "$@" < /dev/null; }
# roll_back <log>: run the rollback command a promotion printed in <log> (also
# when it sits at the end of an error line).
roll_back() {
  local cmd
  cmd=$(grep -h 'Rollback: ' "$1" | tail -n 1 | sed 's/.*Rollback: //' || true)
  [ -n "$cmd" ] || { fail "no rollback command in $1"; return 0; }
  # shellcheck disable=SC2086
  "${cmd%% *}" --yes ${cmd#* } < /dev/null > "$TMP/rollback-again" 2>&1 || { cat "$TMP/rollback-again"; fail "rollback of $1"; }
  settled
}
# settled: wait until the new host passes promote.sh's replication checks. A
# rollback returns once the link is up, which can be before the old host lists
# the replica as online with a recent ack, and the next promotion would stop
# at its checks.
settled() {
  for _ in $(seq 1 100); do
    if cli "$NEW" INFO replication | grep -x master_link_status:up > /dev/null &&
      cli "$OLD" INFO replication | grep -E "^slave0:ip=$NEW_IP,port=6379,state=online,.*,lag=[01]\$" > /dev/null; then
      return 0
    fi
    sleep 0.1
  done
  fail "the new host did not settle as a replica"
}

echo "# Dry run"
digest=$(cli "$OLD" DEBUG DIGEST)
promote --dry-run "$OLD" "$NEW" > "$TMP/dry" 2>&1 || { cat "$TMP/dry"; fail "dry run"; }
check "dry run prints the plan" grep -q "Dry run: nothing changed" "$TMP/dry"
check "dry run prints the rollback command" grep -q "^Rollback afterwards: .* $NEW $OLD$" "$TMP/dry"
check "dry run changes nothing" [ "$(role "$OLD") $(role "$NEW") $(cli "$OLD" DEBUG DIGEST)" = "master slave $digest" ]

echo "# A new host that bootstrap.sh did not set up"
docker exec "$NEW" rm /etc/cron.d/blot-redis
if promote "$OLD" "$NEW" > "$TMP/unbootstrapped" 2>&1; then fail "an unbootstrapped new host stops the promotion"; else ok "an unbootstrapped new host stops the promotion"; fi
check "it says why" grep -q "was not set up by bootstrap.sh" "$TMP/unbootstrapped"
check "nothing switched" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
docker exec "$NEW" touch /etc/cron.d/blot-redis

wait_link() { for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done; }
unchanged() {
  check "the old host is still the master" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
  check "the old host takes writes" [ "$(cli "$OLD" SET probe 1)" = OK ]
  check "the old host is still the active one" marked "$OLD"
  check "the new host is not marked active" sh -c "! docker exec $NEW test -e /etc/blot-redis/active"
  wait_link
}

echo "# A folder lock that stays held"
cli "$OLD" SET blog:test:folder-lock token PX 9000 > /dev/null
if promote "$OLD" "$NEW" > "$TMP/locked" 2>&1; then fail "a held lock stops the promotion"; else ok "a held lock stops the promotion"; fi
check "it says why" grep -q "FAILOVER did not complete (locked)" "$TMP/locked"
unchanged
cli "$OLD" DEL blog:test:folder-lock > /dev/null

echo "# A FAILOVER that cannot complete"
# The replica stops answering once the checks have passed: the script is
# waiting for a folder lock, and the replica sleeps as soon as it expires.
cli "$OLD" SET blog:test:folder-lock token PX 3000 > /dev/null
(while [ "$(cli "$OLD" EXISTS blog:test:folder-lock)" = 1 ]; do sleep 0.1; done; cli "$NEW" DEBUG SLEEP 4 > /dev/null) &
if promote "$OLD" "$NEW" > "$TMP/abort" 2>&1; then fail "a stalled replica fails the promotion"; else ok "a stalled replica fails the promotion"; fi
wait
grep -q "FAILOVER did not complete" "$TMP/abort" || { cat "$TMP/abort"; fail "abort message"; }
grep "^aborted\|^stuck" "$TMP/abort" || true
unchanged

echo "# Promotion under write load"
# Writers on the old host's own address: SETs and lock-style scripts. There is
# no address to follow, so they stop being acknowledged at READONLY. Every
# write the old host acknowledged must be on the new master afterwards.
docker exec -d "$APP" sh -c "i=0; while [ ! -f /tmp/stop ]; do i=\$((i+1)); [ \"\$(redis-cli -h $OLD_IP SET w:\$i \$i)\" = OK ] && echo w:\$i >> /tmp/acked; done"
docker exec -d "$APP" sh -c "i=0; while [ ! -f /tmp/stop ]; do i=\$((i+1)); [ \"\$(redis-cli -h $OLD_IP EVAL 'return redis.call(\"SET\", KEYS[1], ARGV[1])' 1 e:\$i \$i)\" = OK ] && echo e:\$i >> /tmp/acked; done"
# A sync holding a folder lock: the promotion must wait for it.
cli "$OLD" SET blog:test:folder-lock token PX 2500 > /dev/null
sleep 1
start=$(date +%s)
promote "$OLD" "$NEW" > "$TMP/promote" 2>&1 || { cat "$TMP/promote"; fail "promotion"; }
waited=$(($(date +%s) - start))
sed 's/^/  | /' "$TMP/promote"
docker exec "$APP" touch /tmp/stop
sleep 1
check "it waited for the lock" [ "$waited" -ge 2 ]
check "new is the master, old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
check "old replicates from new's own address" sh -c "docker exec $OLD redis6-cli INFO replication | tr -d '\r' | grep -qx master_host:$NEW_IP"
acked=$(docker exec "$APP" sh -c 'wc -l < /tmp/acked' | tr -d ' ')
missing=$(docker exec "$APP" cat /tmp/acked | sed 's/^/EXISTS /' | docker exec -i "$NEW" redis6-cli | grep -cx 0 || true)
echo "# $acked acknowledged writes, $missing missing on the new master"
check "no acknowledged write was lost" [ "$acked" -gt 0 -a "$missing" = 0 ]
check "the old host takes no writes now" sh -c "cli() { docker exec $OLD redis6-cli \"\$@\"; }; cli SET probe 1 | grep -q READONLY"
check "the new host is marked active" marked "$NEW"
check "the old host is not" sh -c "! docker exec $OLD test -e /etc/blot-redis/active"
check "the check key was written" [ "$(cli "$NEW" EXISTS blot:promote:check)" = 1 ]
echo "# took ${waited}s including the lock wait"

echo "# Rollback with the printed command"
rollback=$(sed -n 's/^Rollback: //p' "$TMP/promote")
check "a rollback command is printed" [ -n "$rollback" ]
case "$rollback" in *" --timeout-ms 1000 --lock-wait 5 $NEW $OLD") ok "it swaps the hosts and keeps the options" ;; *) fail "rollback command: $rollback" ;; esac
roll_back "$TMP/promote"
check "old is the master again" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the marker is back on the old host only" sh -c "docker exec $OLD test -e /etc/blot-redis/active && ! docker exec $NEW test -e /etc/blot-redis/active"
check "both hold the same data" [ "$(cli "$OLD" DEBUG DIGEST)" = "$(cli "$NEW" DEBUG DIGEST)" ]
wait_link

# The cases below break one thing in one promotion with a hook in the ssh stub.
# Each leaves the pair as it found it (old the master and marked): the ones
# that complete are rolled back with the command they print.

echo "# A marker that cannot be written"
echo "$NEW" > "$STUB_HOOKS/marker"
if promote "$OLD" "$NEW" > "$TMP/nomarker" 2>&1; then fail "a marker that cannot be written fails the promotion"; else ok "a marker that cannot be written fails the promotion"; fi
# The hook goes once it fires. If it did not, this run stopped too early, and it
# must not fire in a later scenario.
if [ -f "$STUB_HOOKS/marker" ]; then cat "$TMP/nomarker"; rm -f "$STUB_HOOKS/marker"; fi
check "it names the command to run by hand" grep -q "run there: sudo touch /etc/blot-redis/active" "$TMP/nomarker"
check "it does not say Done" sh -c "! grep -q 'Done:' '$TMP/nomarker'"
check "Redis did switch" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
roll_back "$TMP/nomarker"
check "old is the master again after the error" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the marker is back on the old host only" sh -c "docker exec $OLD test -e /etc/blot-redis/active && ! docker exec $NEW test -e /etc/blot-redis/active"
wait_link

echo "# The FAILOVER session dies before the FAILOVER is sent"
echo before > "$STUB_HOOKS/session"
if promote "$OLD" "$NEW" > "$TMP/diebefore" 2>&1; then fail "a session lost before the FAILOVER fails the promotion"; else ok "a session lost before the FAILOVER fails the promotion"; fi
check "it says the FAILOVER did not complete" grep -q "FAILOVER did not complete (unknown)" "$TMP/diebefore"
unchanged

echo "# The FAILOVER session dies and the old host cannot be asked"
# The FAILOVER goes through (new becomes the master, old its replica) but the
# script cannot find out: it must not touch the new host, which a REPLICAOF
# would turn into a second replica with no master left.
echo after-down > "$STUB_HOOKS/session"
if promote "$OLD" "$NEW" > "$TMP/unreachable" 2>&1; then fail "an unreachable old host fails the promotion"; else ok "an unreachable old host fails the promotion"; fi
rm -f "$STUB_HOOKS/down"
check "it says it cannot tell and left the new host alone" grep -q "cannot tell how the FAILOVER ended.*was not touched" "$TMP/unreachable"
check "it did not re-attach the new host" sh -c "! grep -q 'making it a replica' '$TMP/unreachable'"
for _ in $(seq 1 25); do [ "$(role "$NEW")" = master ] && break; sleep 0.2; done
check "new is still the master and old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
# Back to where we started: FAILOVER back, retrying while the old host's link
# comes up.
for _ in $(seq 1 25); do
  [ "$(role "$OLD")" = master ] && break
  cli "$NEW" FAILOVER TO "$OLD_IP" 6379 TIMEOUT 2000 > /dev/null 2>&1 || true
  sleep 0.4
done
wait_link
unchanged

echo "# The FAILOVER session dies after the FAILOVER was sent"
# The FAILOVER completes inside Redis without the script seeing it: old reports
# it is a replica of the new host and the promotion carries on to the end.
echo after > "$STUB_HOOKS/session"
promote "$OLD" "$NEW" > "$TMP/dieafter" 2>&1 || { cat "$TMP/dieafter"; fail "a session lost after the FAILOVER still completes the promotion"; }
check "it found the FAILOVER had completed" grep -q "the FAILOVER did complete; carrying on" "$TMP/dieafter"
check "it finished" grep -q "Done: " "$TMP/dieafter"
check "new is the master, old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
check "old replicates from new's own address" sh -c "docker exec $OLD redis6-cli INFO replication | tr -d '\r' | grep -qx master_host:$NEW_IP"
check "the marker moved" sh -c "docker exec $NEW test -e /etc/blot-redis/active && ! docker exec $OLD test -e /etc/blot-redis/active"
roll_back "$TMP/dieafter"
check "old is the master again after the rollback" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the marker is back on the old host only" sh -c "docker exec $OLD test -e /etc/blot-redis/active && ! docker exec $NEW test -e /etc/blot-redis/active"

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
