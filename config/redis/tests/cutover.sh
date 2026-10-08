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
# acknowledged write under load and moves IP, marker and cron jobs; the
# printed rollback command moves everything back.
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
export PATH="$TMP/bin:$PATH" AWS_STUB_STATE="$TMP/aws-state" AWS_STUB_HOSTS="$OLD:$OLD_IP $NEW:$NEW_IP"
export CUTOVER_CLIENT_WAIT=3

# Production as it will be on the day: the floating IP on the old host, the
# new host bootstrapped and replicating from the old host's own address, and
# the old host's hand-made crontab.
echo "$FIP $OLD_IP" > "$AWS_STUB_STATE"
printf '%s\n%s\n' "$OLD_IP" "$FIP" | docker exec -i "$OLD" sh -c 'cat > /tmp/imds-ips'
echo "$NEW_IP" | docker exec -i "$NEW" sh -c 'cat > /tmp/imds-ips'
docker exec "$OLD" ip addr add "$FIP/32" dev eth0 noprefixroute
docker exec "$NEW" sh -c 'mkdir -p /etc/blot-redis /etc/cron.d && touch /etc/cron.d/blot-redis && printf "#!/bin/sh\n" > /usr/local/bin/backup.sh && chmod +x /usr/local/bin/backup.sh'
printf '0 * * * * /root/hourly.sh\n*/5 * * * * /root/bin/tcpmem-log.sh\n* * * * * /root/stats.sh\n' | docker exec -i "$OLD" crontab -
cli "$OLD" DEBUG POPULATE 200000 key 100 > /dev/null
cli "$OLD" SET ssl:example.com:latest cert > /dev/null
cli "$NEW" REPLICAOF "$OLD_IP" 6379 > /dev/null
for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done
# A client in the "app" connected through the floating IP, reconnecting
# whenever its connection fails, like node-redis.
docker exec -d "$APP" sh -c "while :; do redis-cli -h $FIP -r -1 -i 0.1 PING > /dev/null 2>&1; sleep 0.05; done"
sleep 1

cutover() { "$CUTOVER" --yes --any-time --timeout-ms 1000 --lock-wait 5 "$@" < /dev/null; }

echo "# Dry run"
digest=$(cli "$OLD" DEBUG DIGEST)
cutover --dry-run --app-host "$APP" "$OLD" "$NEW" > "$TMP/dry" 2>&1 || { cat "$TMP/dry"; fail "dry run"; }
check "dry run prints the plan" grep -q "Dry run: nothing changed" "$TMP/dry"
check "dry run lists the old cron jobs" grep -q "/root/hourly.sh" "$TMP/dry"
check "dry run keeps the monitoring cron job" sh -c "! grep -q 'tcpmem-log' '$TMP/dry'"
check "dry run changes nothing" [ "$(role "$OLD") $(role "$NEW") $(cli "$OLD" DEBUG DIGEST)" = "master slave $digest" ]

unchanged() {
  check "the old host is still the master" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
  check "the old host takes writes" [ "$(cli "$OLD" SET probe 1)" = OK ]
  check "the IP stayed on the old host" has_ip "$OLD" "$FIP"
  check "the IP was taken off the new host again" sh -c "! docker exec $NEW ip -4 -o addr show dev eth0 | grep -q ' $FIP/'"
  check "the old cron jobs are untouched" sh -c "! docker exec $OLD crontab -l | grep -q '#cutover#'"
  for _ in $(seq 1 50); do cli "$NEW" INFO replication | grep -qx master_link_status:up && break; sleep 0.2; done
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
crontab=$(docker exec "$OLD" crontab -l)
check "old backup jobs are commented out" sh -c "echo '$crontab' | grep -qx '#cutover# 0 \* \* \* \* /root/hourly.sh' && echo '$crontab' | grep -qx '#cutover# \* \* \* \* \* /root/stats.sh'"
check "the monitoring job is kept" sh -c "echo '$crontab' | grep -qx '\*/5 \* \* \* \* /root/bin/tcpmem-log.sh'"
check "the old crontab is backed up" docker exec "$OLD" sh -c 'grep -qx "0 \* \* \* \* /root/hourly.sh" /root/crontab.before-cutover-*'
check "the client through the floating IP reached the new host" grep -q "Writes unavailable" "$TMP/cutover"
echo "# took ${waited}s including the lock wait"

echo "# Rollback with the printed command"
rollback=$(sed -n 's/^Rollback: //p' "$TMP/cutover")
check "a rollback command is printed" [ -n "$rollback" ]
case "$rollback" in *"--allow-unbootstrapped"*"$NEW $OLD") ok "it swaps the hosts" ;; *) fail "rollback command: $rollback" ;; esac
# shellcheck disable=SC2086
${rollback/ --ip / --yes --any-time --timeout-ms 1000 --ip } < /dev/null > "$TMP/rollback" 2>&1 || { cat "$TMP/rollback"; fail "rollback"; }
check "old is the master again" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the IP is back on the old host" sh -c "docker exec $OLD ip -4 -o addr show dev eth0 | grep -q ' $FIP/' && grep -qx '$FIP $OLD_IP' '$AWS_STUB_STATE'"
check "the marker is back on the old host" [ "$(docker exec "$OLD" cat /etc/blot-redis/floating-ip)" = "$FIP" ]
check "it says how to restore the old cron jobs" grep -q "crontab /root/crontab.before-cutover-" "$TMP/rollback"
check "both hold the same data" [ "$(cli "$OLD" DEBUG DIGEST)" = "$(cli "$NEW" DEBUG DIGEST)" ]

echo "# A failed IP move switches Redis back"
AWS_STUB_FAIL_ASSIGN=1 cutover --app-host "$APP" "$OLD" "$NEW" > "$TMP/noip" 2>&1 && fail "a failed IP move fails the cutover" || ok "a failed IP move fails the cutover"
check "old is the master again after a failed move" [ "$(role "$OLD") $(role "$NEW")" = "master slave" ]
check "the old host takes writes after a failed move" [ "$(cli "$OLD" SET probe 2)" = OK ]

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
