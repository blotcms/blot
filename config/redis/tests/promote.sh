#!/bin/bash
# Runs cutover.sh against Redis containers: old (6.2.12, the production
# version) and new (the newest 6.2), plus an "app" container with a client
# connected through the floating IP. ssh becomes docker exec and the AWS CLI
# is a stub that moves the IP in a state file and in each container's fake
# instance metadata; the ip commands are real, inside the containers. On a
# Docker bridge a container answers ARP for an address it has configured, so
# moving the IP behaves much like a VPC: the client only finds the new host
# once its neighbour entry is flushed, and gets a reset there.
#
# Checks: the dry run changes nothing; a FAILOVER that cannot complete leaves
# the old host the master; the cutover waits for a held folder lock, loses no
# acknowledged write under load and moves IP and marker; a new host that
# bootstrap.sh did not set up is refused; the printed rollback command (with
# its --region) moves everything back; a failed
# IP move switches Redis back; a failed preparation is undone; when the ssh
# session running the FAILOVER dies, the cutover asks the old host how it
# ended: it carries on if the FAILOVER completed, stops with the old host
# still the master if it never started, and stops without touching the new
# host if the old host cannot be asked; when no client reaches the new host
# the cutover exits with an error instead of "Done".
#
# Needs docker and perl. Usage: config/redis/tests/cutover.sh (works on a Mac
# with bash 3.2 too, which checks cutover.sh runs there).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CUTOVER=$(dirname "$HERE")/cutover.sh
PREFIX=blot-cutover-test
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
has_ip() { docker exec "$1" ip -4 -o addr show dev eth0 | grep -q " $2/"; }

echo "# Building the test images"
for version in 6.2.12 6.2; do
  docker build -q -t "$PREFIX:$version" - > /dev/null << EOF
FROM redis:$version-alpine
RUN apk add --no-cache bash coreutils iproute2 > /dev/null && ln -s /usr/local/bin/redis-cli /usr/local/bin/redis6-cli
# sudo -n <command>: everything runs as root here.
RUN printf '#!/bin/sh\n[ "\$1" = -n ] && shift\nexec "\$@"\n' > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo
# Instance metadata: a token, and this interface's IPs from /tmp/imds-ips.
RUN printf '#!/bin/sh\ncase "\$*" in *api/token*) echo token ;; *local-ipv4s*) cat /tmp/imds-ips ;; *) exit 22 ;; esac\n' > /usr/local/bin/curl && chmod +x /usr/local/bin/curl
EOF
done

docker network create "$NET" > /dev/null
run() { docker run -d --name "$1" --network "$NET" --cap-add NET_ADMIN "$PREFIX:$2" redis-server --save '' > /dev/null; }
run "$OLD" 6.2.12
run "$NEW" 6.2
run "$APP" 6.2
addr() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
OLD_IP=$(addr "$OLD"); NEW_IP=$(addr "$NEW")
FIP=$(echo "$OLD_IP" | cut -d. -f1-3).200
echo "# old $OLD_IP, new $NEW_IP, floating $FIP"

# ssh <options> <host> <command>: docker exec in the container named <host>.
# Fault injection for the failure cases: a hook is a file in $STUB_HOOKS that
# a test creates just before the cutover it breaks, and that fires once
# (except "down", which the test removes).
#   session  mode before|after|after-down: the first "bash -s" session that
#            runs FAILOVER TO dies with status 137 and no output, just before
#            the FAILOVER is sent or just after Redis accepted it (after-down
#            also makes every later ssh to that host fail, like a lost host).
#   ipadd    host name: "ip addr add" on that host runs, then ssh reports
#            failure, as if the connection dropped after the command ran.
#   down     host name: every ssh to that host fails (ssh's status 255).
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
if [ -f "$H/ipadd" ] && [ "$host" = "$(cat "$H/ipadd")" ]; then
  case "$*" in
    *"ip addr add"*)
      rm -f "$H/ipadd"
      docker exec -i "$host" sh -c "$*"
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
# aws: the floating IP's owner lives in $AWS_STUB_STATE ("<fip> <owner-ip>");
# assigning it rewrites every container's metadata.
cat > "$TMP/bin/aws" << 'EOF'
#!/bin/bash
args="$*"
read -r fip owner < "$AWS_STUB_STATE"
case "$args" in
  *"sts get-caller-identity"*) echo "arn:aws:sts::000000000000:assumed-role/test/cutover" ;;
  *describe-network-interfaces*)
    ip=$(echo "$args" | sed -n 's/.*Values=\([0-9.]*\).*/\1/p')
    secondary=""; [ "$owner" != "$ip" ] || secondary=$fip
    printf 'eni-%s\ti-%s\tsubnet-test\t%s\t%s\n' "$ip" "$ip" "$ip" "$secondary" ;;
  *assign-private-ip-addresses*)
    [ -z "${AWS_STUB_FAIL_ASSIGN:-}" ] || { echo "stub: assign failed" >&2; exit 254; }
    owner=$(echo "$args" | sed -n 's/.*--network-interface-id eni-\([0-9.]*\).*/\1/p')
    echo "$fip $owner" > "$AWS_STUB_STATE"
    for pair in $AWS_STUB_HOSTS; do
      ips=${pair#*:}; [ "$ips" != "$owner" ] || ips="$ips $fip"
      echo "$ips" | tr ' ' '\n' | docker exec -i "${pair%%:*}" sh -c 'cat > /tmp/imds-ips'
    done ;;
  *) echo "stub aws: unexpected: $args" >&2; exit 2 ;;
esac
EOF
chmod +x "$TMP/bin/ssh" "$TMP/bin/aws"
mkdir -p "$TMP/hooks"
export PATH="$TMP/bin:$PATH" AWS_STUB_STATE="$TMP/aws-state" AWS_STUB_HOSTS="$OLD:$OLD_IP $NEW:$NEW_IP" STUB_HOOKS="$TMP/hooks"
export CUTOVER_CLIENT_WAIT=3

# Production as it is: the floating IP on the old host, both hosts bootstrapped
# (the old one so that a rollback can go back to it) and the new host
# replicating from the old host's own address.
echo "$FIP $OLD_IP" > "$AWS_STUB_STATE"
printf '%s\n%s\n' "$OLD_IP" "$FIP" | docker exec -i "$OLD" sh -c 'cat > /tmp/imds-ips'
echo "$NEW_IP" | docker exec -i "$NEW" sh -c 'cat > /tmp/imds-ips'
docker exec "$OLD" ip addr add "$FIP/32" dev eth0 noprefixroute
for c in "$OLD" "$NEW"; do
  docker exec "$c" sh -c 'mkdir -p /etc/blot-redis /etc/cron.d && touch /etc/cron.d/blot-redis && printf "#!/bin/sh\n" > /usr/local/bin/backup.sh && chmod +x /usr/local/bin/backup.sh'
done
echo "$FIP" | docker exec -i "$OLD" sh -c 'cat > /etc/blot-redis/floating-ip'
cli "$OLD" DEBUG POPULATE 200000 key 100 > /dev/null
cli "$OLD" SET ssl:example.com:latest cert > /dev/null
cli "$NEW" REPLICAOF "$OLD_IP" 6379 > /dev/null
for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done
# A client in the "app" connected through the floating IP, reconnecting
# whenever its connection fails, like node-redis.
docker exec -d "$APP" sh -c "while :; do redis-cli -h $FIP -r -1 -i 0.1 PING > /dev/null 2>&1; sleep 0.05; done"
sleep 1

cutover() { "$CUTOVER" --yes --any-time --timeout-ms 1000 --lock-wait 5 "$@" < /dev/null; }
# roll_back <log>: run the rollback command a cutover printed in <log> (also
# when it sits at the end of an error line).
roll_back() {
  local cmd
  cmd=$(grep -h 'Rollback: ' "$1" | tail -n 1 | sed 's/.*Rollback: //' || true)
  [ -n "$cmd" ] || { fail "no rollback command in $1"; return 0; }
  # shellcheck disable=SC2086
  ${cmd/ --ip / --yes --any-time --timeout-ms 1000 --ip } < /dev/null > "$TMP/rollback-again" 2>&1 || { cat "$TMP/rollback-again"; fail "rollback of $1"; }
}

echo "# Dry run"
digest=$(cli "$OLD" DEBUG DIGEST)
cutover --dry-run --app-host "$APP" "$OLD" "$NEW" > "$TMP/dry" 2>&1 || { cat "$TMP/dry"; fail "dry run"; }
check "dry run prints the plan" grep -q "Dry run: nothing changed" "$TMP/dry"
check "dry run prints the rollback command" grep -q "^Rollback afterwards: .* $NEW $OLD$" "$TMP/dry"
check "dry run changes nothing" [ "$(role "$OLD") $(role "$NEW") $(cli "$OLD" DEBUG DIGEST)" = "master slave $digest" ]

echo "# A new host that bootstrap.sh did not set up"
docker exec "$NEW" rm /etc/cron.d/blot-redis
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/unbootstrapped" 2>&1; then fail "an unbootstrapped new host stops the cutover"; else ok "an unbootstrapped new host stops the cutover"; fi
check "it says why" grep -q "was not set up by bootstrap.sh" "$TMP/unbootstrapped"
check "nothing switched" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
docker exec "$NEW" touch /etc/cron.d/blot-redis

wait_link() { for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done; }
unchanged() {
  check "the old host is still the master" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
  check "the old host takes writes" [ "$(cli "$OLD" SET probe 1)" = OK ]
  check "the IP stayed on the old host" has_ip "$OLD" "$FIP"
  check "the IP was taken off the new host again" sh -c "! docker exec $NEW ip -4 -o addr show dev eth0 | grep -q ' $FIP/'"
  check "the old host is still the active one" [ "$(docker exec "$OLD" cat /etc/blot-redis/floating-ip)" = "$FIP" ]
  check "the new host is not marked active" sh -c "! docker exec $NEW test -e /etc/blot-redis/floating-ip"
  wait_link
}

echo "# A folder lock that stays held"
cli "$OLD" SET blog:test:folder-lock token PX 9000 > /dev/null
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/locked" 2>&1; then fail "a held lock stops the cutover"; else ok "a held lock stops the cutover"; fi
check "it says why" grep -q "FAILOVER did not complete (locked)" "$TMP/locked"
unchanged
cli "$OLD" DEL blog:test:folder-lock > /dev/null

echo "# A FAILOVER that cannot complete"
# The replica stops answering once the checks have passed: the script is
# waiting for a folder lock, and the replica sleeps as soon as it expires.
cli "$OLD" SET blog:test:folder-lock token PX 3000 > /dev/null
(while [ "$(cli "$OLD" EXISTS blog:test:folder-lock)" = 1 ]; do sleep 0.1; done; cli "$NEW" DEBUG SLEEP 4 > /dev/null) &
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/abort" 2>&1; then fail "a stalled replica fails the cutover"; else ok "a stalled replica fails the cutover"; fi
wait
grep -q "FAILOVER did not complete" "$TMP/abort" || { cat "$TMP/abort"; fail "abort message"; }
grep "^aborted\|^stuck" "$TMP/abort" || true
unchanged

echo "# Cutover under write load"
# Writers on the old host's own address: SETs and lock-style scripts. Every
# write the old host acknowledges must be on the new master afterwards.
docker exec -d "$APP" sh -c "i=0; while [ ! -f /tmp/stop ]; do i=\$((i+1)); [ \"\$(redis-cli -h $OLD_IP SET w:\$i \$i)\" = OK ] && echo w:\$i >> /tmp/acked; done"
docker exec -d "$APP" sh -c "i=0; while [ ! -f /tmp/stop ]; do i=\$((i+1)); [ \"\$(redis-cli -h $OLD_IP EVAL 'return redis.call(\"SET\", KEYS[1], ARGV[1])' 1 e:\$i \$i)\" = OK ] && echo e:\$i >> /tmp/acked; done"
# A sync holding a folder lock: the cutover must wait for it.
cli "$OLD" SET blog:test:folder-lock token PX 2500 > /dev/null
sleep 1
start=$(date +%s)
cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/cutover" 2>&1 || { cat "$TMP/cutover"; fail "cutover"; }
waited=$(($(date +%s) - start))
sed 's/^/  | /' "$TMP/cutover"
docker exec "$APP" touch /tmp/stop
sleep 1
check "new is the master, old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
check "old replicates from new's own address" sh -c "docker exec $OLD redis6-cli INFO replication | tr -d '\r' | grep -qx master_host:$NEW_IP"
acked=$(docker exec "$APP" sh -c 'wc -l < /tmp/acked' | tr -d ' ')
missing=$(docker exec "$APP" cat /tmp/acked | sed 's/^/EXISTS /' | docker exec -i "$NEW" redis6-cli | grep -cx 0 || true)
echo "# $acked acknowledged writes, $missing missing on the new master"
check "no acknowledged write was lost" [ "$acked" -gt 0 -a "$missing" = 0 ]
check "the IP is on the new host only" sh -c "docker exec $NEW ip -4 -o addr show dev eth0 | grep -q ' $FIP/' && ! docker exec $OLD ip -4 -o addr show dev eth0 | grep -q ' $FIP/'"
check "AWS has the IP on the new interface" grep -qx "$FIP $NEW_IP" "$AWS_STUB_STATE"
check "the new host is marked active" [ "$(docker exec "$NEW" cat /etc/blot-redis/floating-ip)" = "$FIP" ]
check "the old host is not" sh -c "! docker exec $OLD test -e /etc/blot-redis/floating-ip"
check "the client through the floating IP reached the new host" grep -q "Writes unavailable" "$TMP/cutover"
echo "# took ${waited}s including the lock wait"

echo "# Rollback with the printed command"
rollback=$(sed -n 's/^Rollback: //p' "$TMP/cutover")
check "a rollback command is printed" [ -n "$rollback" ]
case "$rollback" in *" $NEW $OLD") ok "it swaps the hosts" ;; *) fail "rollback command: $rollback" ;; esac
check "it needs no --allow-unbootstrapped" sh -c "! echo '$rollback' | grep -q allow-unbootstrapped"
case "$rollback" in *" --region "*" $NEW $OLD") ok "it keeps the AWS region" ;; *) fail "rollback command without the region: $rollback" ;; esac
# shellcheck disable=SC2086
${rollback/ --ip / --yes --any-time --timeout-ms 1000 --ip } < /dev/null > "$TMP/rollback" 2>&1 || { cat "$TMP/rollback"; fail "rollback"; }
check "old is the master again" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the IP is back on the old host" sh -c "docker exec $OLD ip -4 -o addr show dev eth0 | grep -q ' $FIP/' && grep -qx '$FIP $OLD_IP' '$AWS_STUB_STATE'"
check "the marker is back on the old host" [ "$(docker exec "$OLD" cat /etc/blot-redis/floating-ip)" = "$FIP" ]
check "both hold the same data" [ "$(cli "$OLD" DEBUG DIGEST)" = "$(cli "$NEW" DEBUG DIGEST)" ]

echo "# A failed IP move switches Redis back"
AWS_STUB_FAIL_ASSIGN=1 cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/noip" 2>&1 && fail "a failed IP move fails the cutover" || ok "a failed IP move fails the cutover"
check "old is the master again after a failed move" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the old host takes writes after a failed move" [ "$(cli "$OLD" SET probe 2)" = OK ]

# The cases below break one thing in one cutover with a hook in the ssh stub.
# Each leaves the pair as it found it (old the master, the IP on old): the
# ones that complete are rolled back with the command they print, so they run
# last.
wait_link

echo "# A preparation step that fails is undone"
# "ip addr add" on the new host reports failure after it ran, so the address
# is there and has to be taken off again. (The refresh timers do not exist in
# these containers, so stopping them cannot be made to fail here.)
echo "$NEW" > "$STUB_HOOKS/ipadd"
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/prepfail" 2>&1; then fail "a failed preparation fails the cutover"; else ok "a failed preparation fails the cutover"; fi
check "it says nothing switched" grep -q "preparation failed and was undone; nothing has switched" "$TMP/prepfail"
check "it never reached the FAILOVER" sh -c "! grep -q 'FAILOVER $OLD' '$TMP/prepfail'"
unchanged

echo "# The FAILOVER session dies before the FAILOVER is sent"
echo before > "$STUB_HOOKS/session"
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/diebefore" 2>&1; then fail "a session lost before the FAILOVER fails the cutover"; else ok "a session lost before the FAILOVER fails the cutover"; fi
check "it says the FAILOVER did not complete" grep -q "FAILOVER did not complete (unknown)" "$TMP/diebefore"
unchanged

echo "# The FAILOVER session dies and the old host cannot be asked"
# The FAILOVER goes through (new becomes the master, old its replica) but the
# script cannot find out: it must not touch the new host, which a REPLICAOF
# would turn into a second replica with no master left.
echo after-down > "$STUB_HOOKS/session"
if cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/unreachable" 2>&1; then fail "an unreachable old host fails the cutover"; else ok "an unreachable old host fails the cutover"; fi
rm -f "$STUB_HOOKS/down"
check "it says it cannot tell and left the new host alone" grep -q "cannot tell how the FAILOVER ended.*was not touched" "$TMP/unreachable"
check "it did not re-attach the new host" sh -c "! grep -q 'making it a replica' '$TMP/unreachable'"
for _ in $(seq 1 25); do [ "$(role "$NEW")" = master ] && break; sleep 0.2; done
check "new is still the master and old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
# Back to where we started: the preparation was left in place on purpose, so
# take the address off the new host, then FAILOVER back (retrying while the
# old host's link comes up). While both hosts had the address the app may have
# learned the new host's MAC for it: forget it, or its connections black-hole.
docker exec "$NEW" ip addr del "$FIP/32" dev eth0
docker exec "$APP" ip neigh del "$FIP" dev eth0 2> /dev/null || true
for _ in $(seq 1 25); do
  [ "$(role "$OLD")" = master ] && break
  cli "$NEW" FAILOVER TO "$OLD_IP" 6379 TIMEOUT 2000 > /dev/null 2>&1 || true
  sleep 0.4
done
wait_link
unchanged

echo "# No client reaches the new host"
# The app's neighbour entry for the IP pinned to the old host's MAC address
# (a permanent entry, which no ARP reply replaces; both hosts answer ARP while
# both have the IP) and no flush: after the move the app keeps sending to the
# old host, which no longer has the IP. Redis has switched but no client
# arrives, so the cutover reports an error and prints the rollback, which we
# run with the entry removed and the flush on so the clients come back.
docker exec "$APP" ip neigh replace "$FIP" lladdr "$(docker exec "$OLD" cat /sys/class/net/eth0/address)" dev eth0 nud permanent
sleep 1
if cutover --no-neigh-flush "$OLD" "$NEW" > "$TMP/noclients.out" 2> "$TMP/noclients.err"; then
  cat "$TMP/noclients.out" "$TMP/noclients.err"
  fail "no client on the new host fails the cutover"
else
  ok "no client on the new host fails the cutover"
fi
check "it says none of the clients reached the new host" grep -q "none of the [1-9][0-9]* clients reached" "$TMP/noclients.err"
check "it does not say Done" sh -c "! grep -q 'Done:' '$TMP/noclients.out' '$TMP/noclients.err'"
check "it tells how to roll back" grep -q "Rollback: " "$TMP/noclients.err"
check "Redis did switch" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
check "the IP is on the new host" has_ip "$NEW" "$FIP"
docker exec "$APP" ip neigh del "$FIP" dev eth0
sed "s/ --no-neigh-flush / --app-host $APP /" "$TMP/noclients.err" > "$TMP/noclients.flush"
roll_back "$TMP/noclients.flush"
check "old is the master again after the error" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
wait_link
sleep 1

echo "# The FAILOVER session dies after the FAILOVER was sent"
# The FAILOVER completes inside Redis without the script seeing it: old reports
# it is a replica of the new host and the cutover carries on to the end.
echo after > "$STUB_HOOKS/session"
cutover --region eu-west-1 --app-host "$APP" "$OLD" "$NEW" > "$TMP/dieafter" 2>&1 || { cat "$TMP/dieafter"; fail "a session lost after the FAILOVER still completes the cutover"; }
check "it found the FAILOVER had completed" grep -q "the FAILOVER did complete; carrying on" "$TMP/dieafter"
check "it finished" grep -q "Done: " "$TMP/dieafter"
check "new is the master, old its replica" [ "$(role "$NEW") $(role "$OLD")" = "master slave" ]
check "old replicates from new's own address" sh -c "docker exec $OLD redis6-cli INFO replication | tr -d '\r' | grep -qx master_host:$NEW_IP"
check "the IP is on the new host only" sh -c "docker exec $NEW ip -4 -o addr show dev eth0 | grep -q ' $FIP/' && ! docker exec $OLD ip -4 -o addr show dev eth0 | grep -q ' $FIP/'"
check "AWS has the IP on the new interface" grep -qx "$FIP $NEW_IP" "$AWS_STUB_STATE"
check "the rollback command carries the region" grep -q "Rollback: .* --region eu-west-1 $NEW $OLD" "$TMP/dieafter"
roll_back "$TMP/dieafter"
check "old is the master again after the rollback" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the IP is back on the old host" sh -c "docker exec $OLD ip -4 -o addr show dev eth0 | grep -q ' $FIP/' && grep -qx '$FIP $OLD_IP' '$AWS_STUB_STATE'"

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
