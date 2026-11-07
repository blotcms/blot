#!/bin/bash
# Tests config/host/cycle.sh on a copy of it among stub scripts, with stub aws,
# ssh, curl and date: no Docker, no AWS, no real host. The stubs keep a small
# world in $W (who is the Redis master, where the Elastic IP is, what runs where)
# and each appends what it did to $W/calls, in order, so the tests read the order
# of a phase and run it again against the state it left.
#
# Hosts: old, new and oldredis are themselves; direct reaches old another way;
# eipalias reaches whichever host has the Elastic IP, as the blot alias does.
#
# Usage: config/host/tests/cycle.sh   (also run it with /bin/bash on a Mac: 3.2)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILED=0

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }

W=$TMP/world
mkdir -p "$TMP/bin" "$W" "$TMP/tree/config/host" "$TMP/tree/config/redis" "$TMP/tree/scripts/deploy" "$TMP/tree/data" "$TMP/home/.ssh"
export HOME="$TMP/home"
cp "$REPO/config/host/cycle.sh" "$TMP/tree/config/host/cycle.sh"
git -C "$TMP/tree" init -q
echo /data > "$TMP/tree/.gitignore"
touch "$TMP/tree/key"
BANS=$TMP/tree/data/bans.txt
CYCLE=$TMP/tree/config/host/cycle.sh
OLD_SHA=1111111111111111111111111111111111111111
IMAGE=ghcr.io/blotcms/blot:$OLD_SHA

# ---- stubs ---------------------------------------------------------------

cat > "$TMP/bin/ssh" << 'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in
    -n) shift ;;
    -o | -i | -p) shift 2 ;;
    -F) cp "$2" "$W/override_cfg"; F=1; shift 2 ;;
    -G) case "$2" in
        eipalias) echo "hostname 203.0.113.9" ;;
        new) echo "hostname 192.0.2.20" ;;
        newip) echo "hostname 203.0.113.9" ;;
        *) echo "hostname 192.0.2.10" ;;
      esac
      echo "port 2222"; exit 0 ;;
    *) break ;;
  esac
done
name=$1; shift
cmd=$*
case "$name" in
  eipalias) m=$(cat "$W/eip_on") ;;
  direct) m=old ;;
  newip) m=new ;;
  ec2-user@*) m=new ;;
  *) m=$name ;;
esac
[ ! -e "$W/down.$m" ] || exit 255
# A connection reset while an association reaches the instance.
if [ -n "${F:-}" ] && [ -s "$W/ssh_resets" ]; then
  n=$(cat "$W/ssh_resets")
  if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$W/ssh_resets"; exit 255; fi
fi
# Gone at its launch address: reachable only through the override that names the Elastic IP.
[ ! -e "$W/gone.$m" ] || [ -n "${F:-}" ] || exit 255
# The launch address of <new> is released: it and a jump through it answer
# only once follow_eip has pointed ssh at the Elastic IP (-F).
[ ! -e "$W/launch_released" ] || [ -n "${F:-}" ] || case "$name" in new | direct) exit 255 ;; esac
case "$cmd" in
  *meta-data/instance-id*) echo "i-0$(printf %s "$m" | od -An -tx1 | tr -d ' \n' | cut -c1-8)"; exit 0 ;;
esac
echo "ssh $name [$m]: $cmd" >> "$W/calls"
[ -z "${F:-}" ] || echo "$name: $cmd" >> "$W/override_calls"
case "$cmd" in
  *"test -e /etc/blot/drill"*) [ -e "$W/drillmark.$m" ] ;;
  *"test -e /etc/blot-redis/drill"*) [ -e "$W/redisdrill.$m" ] ;;
  *"test -e /etc/blot/cycle-env-pending"*) [ -e "$W/etc.$m/cycle-env-pending" ] ;;
  *"rm -f /etc/blot/cycle-env-pending"*) rm -f "$W/etc.$m/cycle-env-pending" ;;
  *"INFO replication"*)
    echo "role:$(cat "$W/role.$m" 2> /dev/null || echo master)"
    echo "master_host:$(cat "$W/master.$m" 2> /dev/null)"
    echo "master_link_status:$(cat "$W/link.$m" 2> /dev/null)" ;;
  *DBSIZE*) cat "$W/keys.$m" 2> /dev/null || echo 0 ;;
  *"ip -4 -o route get"*) case "$m" in old) a=10.0.0.1 ;; new) a=10.0.0.2 ;; *) a=10.0.0.3 ;; esac
    echo "1.1.1.1 via 10.0.0.254 dev eth0 src $a uid 1000" ;;
  *REPLICAOF*) echo slave > "$W/role.$m"; echo "${cmd#*REPLICAOF }" | cut -d' ' -f1 > "$W/master.$m"; echo up > "$W/link.$m" ;;
  *"docker ps -q"*) [ ! -e "$W/units.$m" ] || echo abc123 ;;
  *"docker inspect"*"State.Health"*) [ -e "$W/units.$m" ] && echo healthy ;;
  *"docker inspect"*"Config.Env"*) [ -e "$W/units.$m" ] && cat "$W/env.$m" ;;
  *"docker inspect"*"Config.Image"*) cat "$W/image.$m" ;;
  *"docker inspect"*) echo running ;;
  *"docker stop"*) rm -f "$W/units.$m" ;;
  *"read-only.js on"*) touch "$W/frozen" ;;
  *"read-only.js off"*) rm -f "$W/frozen"; echo '{"readOnly":null,"lockedBlogs":[]}' ;;
  *"read-only.js status"*)
    locks="[]"; [ -z "${STUB_LOCKS:-}" ] || locks='["b1"]'
    if [ -e "$W/frozen" ]; then echo "{\"readOnly\":{\"reason\":\"${STUB_FREEZE_REASON:-host cycle}\"},\"lockedBlogs\":$locks}"
    else echo "{\"readOnly\":null,\"lockedBlogs\":$locks}"; fi ;;
  *"tee /etc/blot/deploy-paused"*) cat > /dev/null; touch "$W/paused.$m" ;;
  *"test -e /etc/blot/deploy-paused"*) [ -e "$W/paused.$m" ] ;;
  *"test ! -e /etc/blot/deploy-paused"*) [ ! -e "$W/paused.$m" ] ;;
  *"rm -f /etc/blot/deploy-paused"*) rm -f "$W/paused.$m" ;;
  *"sudo tar -C /etc/blot -cf -"*) tar -C "$W/etc.$m" -cf - secrets.env proxy.env ;;
  # The real script against this machine's directory, with setfacl and runuser stubbed.
  *"sudo bash -c"*) script=${cmd#sudo bash -c }; eval "bash -c ${script//\/etc\/blot/$W/etc.$m}" ;;
  *"sed -n 's/^BLOT_HOST"*) echo blot.test ;;
  *"mountpoint -q"*) [ ! -e "$W/nomount.$m" ] ;;
  *'grep -qs "^\[blot-b2\]"'*) true ;;
  *'grep -qs "^\[blot-b2-storage\]"'*) [ -z "${STUB_NO_B2_STORAGE:-}" ] ;;
  *"cat /etc/blot/storage-offsite-bucket"*) [ -n "${STUB_NO_B2_STORAGE:-}" ] || echo test-storage-offsite ;;
  *"tee /etc/blot/storage-offsite-bucket"*) cat > "$W/storage-offsite.$m" ;;
  *"grep -qsxF"*) [ -n "${STUB_NEW_HAS_B2:-}" ] || { [ -n "${STUB_NEW_HAS_B2_CREDS:-}" ] && [[ "$cmd" == *credentials* ]]; } ;;
  *".aws/credentials"*) cat > /dev/null; touch "$W/creds.$m" ;;
  *"aws sts"*) [ -z "${STUB_NO_BACKUP_KEY:-}" ] && { [ -z "${STUB_AWS_AFTER_COPY:-}" ] || [ -e "$W/aws-copied" ]; } ;;
  *'tar -C "$HOME" -xf -'*) cat > /dev/null; touch "$W/aws-copied" ;;
  *"curl -sS"*"cdn.blot.test"*"/layout.css"*) echo "${STUB_STATIC:-200}" ;;
  *"curl -sS"*) echo "${STUB_PROBE:-200}" ;;
  *"tar -C"*) cat > /dev/null ;;
esac
EOF

cat > "$TMP/bin/aws" << 'EOF'
#!/bin/bash
a=$*
echo "aws $a" >> "$W/calls"
case "$a" in
  # restore: the new host's tags
  *"describe-instances --instance-ids"*BlotCycle*) cat "$W/cycle_tag" ;;
  *describe-instance-status*) echo ok ;;
  *"describe-instances --filters"*) cat "$W/cycle_instance" 2> /dev/null || true ;;
  *"describe-instances --instance-ids"*"State.Name"*) echo running ;;
  *"describe-instances --instance-ids"*) cat "$W/tag" ;;
  *"describe-addresses"*"Addresses[0].PublicIp"*) echo 203.0.113.9 ;;
  *"describe-addresses"*"[InstanceId,PublicIp]"*) echo "$(cat "$W/eip_id") 203.0.113.9" ;;
  *"describe-addresses"*) cat "$W/eip_id" ;;
  *associate-address*) m=${a##*--instance-id }; echo "${m%% *}" > "$W/eip_id"; echo new > "$W/eip_on"
    [ ! -e "$W/flaky_move" ] || echo 2 > "$W/ssh_resets" ;;
  *"describe-instance-attribute"*) cat "$W/protection" ;;
esac
EOF

cat > "$TMP/bin/curl" << 'EOF'
#!/bin/bash
echo "curl $*" >> "$W/calls"
echo "${STUB_PROBE:-200}"
EOF

# The clock cycle.sh checks, and the real date for everything else.
cat > "$TMP/bin/date" << 'EOF'
#!/bin/bash
if [ "$*" = "-u +%H%M" ]; then echo "${STUB_TIME:-1200}"; else exec /bin/date "$@"; fi
EOF

printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/sleep"
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/setfacl"
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/runuser"
printf '#!/bin/bash\necho "$(basename "$0") $*" >> "$W/calls"\n' > "$TMP/tree/config/host/bootstrap.sh"
cp "$TMP/tree/config/host/bootstrap.sh" "$TMP/tree/config/host/bans.sh"
cp "$TMP/tree/config/host/bootstrap.sh" "$TMP/tree/config/host/wildcard-cert.sh"

cat > "$TMP/tree/config/redis/restore.sh" << 'EOF'
#!/bin/bash
echo "restore.sh $*" >> "$W/calls"
[ -n "${STUB_RESTORE_NOOP:-}" ] || echo 100 > "$W/keys.new"
EOF
mkdir -p "$TMP/in"
printf 'BLOT_HOST=blot.test\nexport BLOT_SESSION_SECRET=s\n' > "$TMP/in/secrets.env"
printf 'BLOT_HOST=blot.test\nPROXY_PRIVATE_IP=127.0.0.1\n' > "$TMP/in/proxy.env"
printf '[default]\naws_access_key_id = x\naws_secret_access_key = y\n' > "$TMP/in/credentials"

cat > "$TMP/tree/config/host/launch.sh" << 'EOF'
#!/bin/bash
echo "launch.sh $*" >> "$W/calls"
case "$*" in *--dry-run*) exit 0 ;; esac
echo "i-0new 192.0.2.20" > "$W/cycle_instance"
EOF
cat > "$TMP/tree/config/host/deploy.sh" << 'EOF'
#!/bin/bash
echo "deploy.sh PUBLIC_IP=$PUBLIC_IP SSH_PORT=$SSH_PORT SSH_KEY=$SSH_KEY SSH_OPTS=${SSH_OPTS:-}" >> "$W/calls"
EOF
cat > "$TMP/tree/config/redis/promote.sh" << 'EOF'
#!/bin/bash
echo "promote.sh $*" >> "$W/calls"
case "$*" in *--dry-run*) [ -z "${STUB_PROMOTE_PRECHECK_FAILS:-}" ]; exit ;; esac
[ -z "${STUB_PROMOTE_FAILS:-}" ] || { echo "FAILOVER did not complete" >&2; exit 1; }
echo master > "$W/role.new"; echo slave > "$W/role.old"; echo 10.0.0.2 > "$W/master.old"; echo 100 > "$W/keys.new"
EOF
cat > "$TMP/tree/scripts/deploy/units.sh" << 'EOF'
#!/bin/bash
echo "units.sh $* target=$BLOT_DEPLOY_TARGET ignore_pause=${PROXY_DEPLOY_IGNORE_PAUSE:-} force=${PROXY_DEPLOY_FORCE:-} skip_write=${PROXY_VERIFY_SKIP_REDIS_WRITE:-}" >> "$W/calls"
[ -z "${STUB_UNITS_FAIL:-}" ] || exit 1
touch "$W/units.new"
grep -q '^BLOT_REDIS_SOCKET=/run/blot/redis/redis.sock$' "$W/etc.new/secrets.env" && echo '["BLOT_REDIS_SOCKET=/run/blot/redis/redis.sock"]' > "$W/env.new"
echo "ghcr.io/blotcms/blot:$1" > "$W/image.new"
EOF
chmod +x "$TMP"/bin/* "$CYCLE" "$TMP"/tree/config/host/*.sh "$TMP/tree/config/redis/promote.sh" "$TMP/tree/config/redis/restore.sh" "$TMP/tree/scripts/deploy/units.sh"

# ---- the world -----------------------------------------------------------

# world: two old units on one image, a Redis master, a built new host, drill tags.
world() {
  rm -rf "$W"; mkdir -p "$W/etc.old" "$W/etc.new"
  touch "$W/units.old" "$W/drillmark.old"
  echo "$IMAGE" > "$W/image.old"
  echo true > "$W/tag"
  echo old > "$W/eip_on"
  echo i-06f6c64 > "$W/eip_id"
  echo False > "$W/protection"
  echo t1 > "$W/cycle_tag"
  printf 'BLOT_HOST=blot.test\nBLOT_REDIS_HOST=10.0.0.200\nexport BLOT_SESSION_SECRET=s\n' > "$W/etc.old/secrets.env"
  printf 'BLOT_HOST=blot.test\nPROXY_REDIS_HOST=10.0.0.200\nPROXY_PRIVATE_IP=127.0.0.1\n' > "$W/etc.old/proxy.env"
  cp "$W/etc.old/secrets.env" "$W/etc.old/proxy.env" "$W/etc.new/"
}
OLD_ID=i-06f6c64 # what the ssh stub's metadata answers for old
NEW_ID=i-06e6577
# ready_for_switch: the world after app has run.
ready_for_switch() {
  world
  echo slave > "$W/role.new"; echo 10.0.0.1 > "$W/master.new"; echo up > "$W/link.new"
  touch "$W/units.new" "$W/paused.old" "$W/paused.new"
  echo "$IMAGE" > "$W/image.new"
  echo '["BLOT_REDIS_SOCKET=/run/blot/redis/redis.sock"]' > "$W/env.new"
}

# run <args...>: cycle.sh against the stubs; sets OUT, STATUS and CALLS.
run() {
  : >> "$W/calls"
  local before
  before=$(wc -l < "$W/calls")
  STATUS=0
  OUT=$(W=$W PATH="$TMP/bin:$PATH" AWS_PROFILE=test AWS_REGION=test-1 BLOT_HOST_SSH_KEY="$TMP/tree/key" BLOT_SSH_PORT=2222 \
    REDIS_MAXMEMORY=1gb "$CYCLE" "$@" 2>&1 < /dev/null) || STATUS=$?
  CALLS=$(tail -n "+$((before + 1))" "$W/calls")
}
has() { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok "$1"; else fail "$1 (no '$3' in: $2)"; fi; }
lacks() { if printf '%s\n' "$2" | grep -qF -- "$3"; then fail "$1 (found '$3' in: $2)"; else ok "$1"; fi; }
status_is() { if [ "$STATUS" = "$2" ]; then ok "$1"; else fail "$1 (status $STATUS: $OUT)"; fi; }
refused() { if [ "$STATUS" != 0 ]; then ok "$1"; else fail "$1 (it went on: $OUT)"; fi; }
before() { # before <description> <first> <second>: in CALLS
  local a b
  a=$(printf '%s\n' "$CALLS" | grep -nF -- "$2" | head -n 1 | cut -d: -f1 || true)
  b=$(printf '%s\n' "$CALLS" | grep -nF -- "$3" | head -n 1 | cut -d: -f1 || true)
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$1"; else fail "$1 ('$2' at ${a:-none}, '$3' at ${b:-none}): $CALLS"; fi
}
# Nothing here changes a thing: no call but reads.
no_changes() {
  lacks "$1: no REPLICAOF" "$CALLS" "REPLICAOF"
  lacks "$1: no EIP move" "$CALLS" "associate-address"
  lacks "$1: no units" "$CALLS" "units.sh"
  lacks "$1: no docker stop" "$CALLS" "docker stop"
  lacks "$1: no pause" "$CALLS" "tee /etc/blot/deploy-paused"
  lacks "$1: no freeze" "$CALLS" "read-only.js on"
  lacks "$1: no termination" "$CALLS" "terminate-instances"
}

# ---- guardrails ----------------------------------------------------------

echo "# refusals"
world
run replicate old new
refused "neither --drill nor --production is refused"
has "and it says so" "$OUT" "--drill"
run --drill --production replicate old new
refused "both are refused"
run --drill frobnicate old new
refused "an unknown phase is refused"
run --drill restore old new extra
refused "restore takes at most the new host's name"
run --drill replicate old
refused "a phase without <new> is refused"
run --production replicate old new
refused "--production against a drill-tagged host is refused"
has "naming the tag" "$OUT" "tagged BlotDrill=true"
no_changes "--production on a drill host"
echo None > "$W/tag"
run --drill replicate old new
refused "--drill against an untagged host is refused"
no_changes "--drill on an untagged host"
echo true > "$W/tag"; rm "$W/drillmark.old"
run --drill replicate old new
refused "--drill against an old host without /etc/blot/drill is refused"
touch "$W/drillmark.old"
run --drill replicate eipalias eipalias
refused "<old> and <new> being one instance is refused"
has "and says so" "$OUT" "same instance"
STATUS=0
OUT=$(W=$W PATH="$TMP/bin:$PATH" "$CYCLE" --drill replicate old new 2>&1 < /dev/null) || STATUS=$?
refused "AWS_PROFILE and AWS_REGION are the maintainer's to set"

echo "# the time window"
for t in 0100 0159 0045 0500 0559 0445; do
  STUB_TIME=$t run --drill replicate old new
  refused "$t UTC is refused"
done
no_changes "inside the window"
for t in 0044 0200 0444 0600 2359; do
  world
  STUB_TIME=$t run --drill replicate old new
  status_is "$t UTC is allowed" 0
done
world
STUB_TIME=0130 run --drill --any-time replicate old new
status_is "--any-time overrides it" 0
has "with a warning" "$OUT" "WARNING"
world
STUB_TIME=0130 run --drill --dry-run replicate old new
status_is "a dry run only notes it" 0
has "the note" "$OUT" "would refuse"

# ---- launch --------------------------------------------------------------

echo "# launch"
world
run --drill launch old
refused "launch needs --type"
run --drill --type t launch old
refused "launch needs --cycle"
run --drill --type m6gd.xlarge --cycle c1 --dry-run launch old
status_is "launch dry run works" 0
has "dry run asks launch.sh for its dry run" "$CALLS" "--dry-run"
lacks "dry run touches no host" "$CALLS" "deploy.sh PUBLIC_IP"
run --drill --type m6gd.xlarge --cycle c1 launch old
status_is "launch works" 0
has "launch.sh is tagged with the cycle" "$CALLS" "--tag BlotCycle=c1"
has "a drill launches a drill host" "$CALLS" "--drill"
has "the drill markers are set" "$CALLS" "/etc/blot/drill /etc/blot-redis/drill"
before "launch.sh, then deploy.sh" "launch.sh" "deploy.sh PUBLIC_IP=192.0.2.20 SSH_PORT=2222"
has "deploy.sh does not record the new host's key" "$CALLS" "SSH_OPTS=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
lacks "no data volume" "$CALLS" "DATA_VOLUME_ID"
lacks "the root disk is launch.sh's default" "$CALLS" "--root-gb"
has "it says what to add" "$OUT" "HostName 192.0.2.20"
lacks "not npm run deploy-host" "$CALLS" "deploy-host"
run --drill --type m6gd.xlarge --cycle c1 launch old
status_is "launch runs again" 0
lacks "it launches nothing the second time" "$CALLS" "launch.sh"
has "it sets the host up again" "$CALLS" "bootstrap.sh ec2-user@192.0.2.20"
world
run --drill --type m6gd.xlarge --root-gb 30 --cycle c3 launch old
status_is "launch with --root-gb works" 0
has "--root-gb reaches launch.sh" "$CALLS" "--root-gb 30"
run --drill --type m6gd.xlarge --root-gb big --cycle c3 launch old
refused "a --root-gb that is not a number is refused"
echo None > "$W/tag"
run --production --type m6gd.xlarge --cycle c2 launch old
status_is "a production launch works" 0
echo "i-1 192.0.2.1
i-2 192.0.2.2" > "$W/cycle_instance"
run --production --type m6gd.xlarge --cycle c2 launch old
refused "two instances with the tag are refused"

# ---- replicate -----------------------------------------------------------

echo "# replicate"
world
run --drill --dry-run replicate old new
status_is "replicate dry run works" 0
no_changes "replicate dry run"
run --drill replicate old new
status_is "replicate works" 0
has "the replica's own primary IP of the old host" "$CALLS" "REPLICAOF 10.0.0.1 6379"
has "the output buffer goes up first" "$CALLS" "client-output-buffer-limit"
run --drill replicate old new
status_is "replicate runs again" 0
lacks "with no second REPLICAOF" "$CALLS" "REPLICAOF"
world
run --drill --old-redis oldredis replicate old new
refused "two hosts: --old-redis without /etc/blot-redis/drill is refused"
has "and says so" "$OUT" "/etc/blot-redis/drill"
no_changes "an unmarked --old-redis"
touch "$W/down.oldredis"
run --drill --old-redis oldredis replicate old new
refused "an unreachable --old-redis is refused"
no_changes "an unreachable --old-redis"
rm "$W/down.oldredis"
touch "$W/redisdrill.oldredis"
run --production --old-redis oldredis replicate old new
refused "--production is still refused: the tags say drill"
run --drill --old-redis oldredis replicate old new
status_is "two hosts: replicate from --old-redis" 0
has "from that host's address" "$CALLS" "REPLICAOF 10.0.0.3 6379"
has "its instance is checked against the world" "$CALLS" "describe-instances --instance-ids"
echo 10.9.9.9 > "$W/master.new"
run --drill replicate old new
refused "a replica of something else is refused"
world
echo 100 > "$W/keys.new"
run --drill replicate old new
refused "a master with data is never wiped by REPLICAOF"
lacks "no REPLICAOF on it" "$CALLS" "REPLICAOF"
world
echo 3 > "$W/keys.new"
run --drill replicate old new
status_is "a fresh master holding its samplers' keys is replicated" 0
has "it becomes a replica" "$CALLS" "REPLICAOF 10.0.0.1 6379"
world
echo 11 > "$W/keys.new"
run --drill replicate old new
refused "a master over the fresh limit is refused"
world
touch "$W/role.old"; echo slave > "$W/role.old"
run --drill replicate old new
refused "the old Redis has to be a master"

# ---- no data phase ------------------------------------------------------

echo "# data"
world
run --drill data old new
refused "there is no data phase any more"
no_changes "data"

# ---- app -----------------------------------------------------------------

echo "# app"
world
run --drill app old new
refused "app needs a replica"
lacks "before pausing anything" "$CALLS" "deploy-paused"
ready_for_switch
rm "$W/units.new" "$W/paused.old" "$W/paused.new"
touch "$W/nomount.new"
run --drill app old new
refused "app needs the instance store mounted"
rm "$W/nomount.new"
run --drill --dry-run app old new
status_is "app dry run works" 0
no_changes "app dry run"
chmod 640 "$W/etc.old/secrets.env" "$W/etc.old/proxy.env"
run --drill --verify-host blog.blot.test app old new
status_is "app works" 0
has "deploys pause on the old host" "$CALLS" "ssh old [old]: sudo mkdir -p /etc/blot && echo"
has "deploys pause on the new host" "$CALLS" "ssh new [new]: sudo mkdir -p /etc/blot && echo"
before "pause before anything starts" "deploy-paused" "units.sh"
before "the certificate before the units" "wildcard-cert.sh new" "units.sh"
before "docker starts before the units" "systemctl start docker" "units.sh"
has "the old host's image, skipping the write check, past the pause" "$CALLS" "units.sh $OLD_SHA target=new ignore_pause=1 force=1 skip_write=1"
has "the socket goes in the new secrets.env" "$(cat "$W/etc.new/secrets.env")" "BLOT_REDIS_SOCKET=/run/blot/redis/redis.sock"
has "and the new proxy.env" "$(cat "$W/etc.new/proxy.env")" "PROXY_REDIS_HOST=unix:/run/blot/redis/redis.sock"
lacks "replacing the old value" "$(cat "$W/etc.new/proxy.env")" "PROXY_REDIS_HOST=10.0.0.200"
has "other values survive" "$(cat "$W/etc.new/secrets.env")" "export BLOT_SESSION_SECRET=s"
lacks "the old secrets.env is untouched" "$(cat "$W/etc.old/secrets.env")" "BLOT_REDIS_SOCKET"
has "the old proxy.env is untouched" "$(cat "$W/etc.old/proxy.env")" "PROXY_REDIS_HOST=10.0.0.200"
mode() { ls -l "$1" | cut -c1-10; }
[ "$(mode "$W/etc.new/secrets.env")" = -rw-r----- ] && ok "secrets.env keeps its mode" || fail "secrets.env mode is $(mode "$W/etc.new/secrets.env")"
[ "$(mode "$W/etc.new/proxy.env")" = -rw-r----- ] && ok "proxy.env keeps its mode" || fail "proxy.env mode is $(mode "$W/etc.new/proxy.env")"
has "the site is checked through the private IP" "$CALLS" "--resolve blot.test:443:10.0.0.2 https://blot.test/health"
has "and --verify-host" "$CALLS" "--resolve blog.blot.test:443:10.0.0.2 https://blog.blot.test/"
lacks "a drill copies no backup key" "$CALLS" 'tar -C "$HOME" -cf - .aws'
lacks "nor the storage offsite profile or bucket file" "$CALLS" "blot-b2-storage"
[ ! -e "$W/storage-offsite.new" ] && ok "a drill gets no storage offsite bucket file" || fail "a drill got /etc/blot/storage-offsite-bucket"
run --drill app old new
status_is "app runs again" 0
has "with nothing to change it forces nothing" "$CALLS" "force= skip_write=1"
ready_for_switch
rm "$W/units.new"
STUB_PROBE=502 run --drill app old new
refused "a failed check through the private IP stops it"
ready_for_switch
rm "$W/units.new"
run --drill app old new
has "a static file is fetched from the CDN host through the private IP" "$CALLS" "--resolve cdn.blot.test:443:10.0.0.2 https://cdn.blot.test/layout.css"
ready_for_switch
rm "$W/units.new"
STUB_STATIC=404 run --drill app old new
refused "an unfilled static directory stops it"
has "and says so" "$OUT" "layout.css"
ready_for_switch
rm "$W/units.new"
STUB_UNITS_FAIL=1 run --drill app old new
refused "a failed deploy stops it"
# The env files were replaced by that run, so the next one finds them current.
[ -e "$W/etc.new/cycle-env-pending" ] && ok "the changed env is remembered on the host" || fail "no cycle-env-pending after a failed deploy"
run --drill app old new
status_is "app runs again after the failed deploy" 0
has "and still forces the replacement of the units" "$CALLS" "force=1 skip_write=1"
[ ! -e "$W/etc.new/cycle-env-pending" ] && ok "the marker goes once the units are verified" || fail "cycle-env-pending is still there"
run --drill app old new
has "after that nothing is forced" "$CALLS" "force= skip_write=1"
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
STUB_AWS_AFTER_COPY=1 run --production app old new
status_is "a production app works" 0
has "it copies the backup key from the old Redis" "$CALLS" 'tar -C "$HOME" -cf - .aws'
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
run --production app old new
status_is "a production app with working credentials works" 0
lacks "it leaves them alone, as an old host on an instance profile has no key to copy" "$CALLS" 'tar -C "$HOME" -cf - .aws'
has "and adds the offsite profile, which backup.sh needs" "$CALLS" '[blot-b2]'
has "and the storage offsite profile's credentials, from the old app host" "$CALLS" "ssh old [old]: awk -v s='[blot-b2-storage]'"
has "and its config section" "$CALLS" "awk -v s='[profile blot-b2-storage]'"
[ "$(cat "$W/storage-offsite.new" 2> /dev/null)" = test-storage-offsite ] &&
  ok "and the storage offsite bucket file" || fail "the storage offsite bucket file was not copied"
rm -f "$W/storage-offsite.new"
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
STUB_NO_B2_STORAGE=1 run --production app old new
status_is "a production app works without the storage offsite settings on the old host" 0
lacks "and copies no storage offsite profile" "$CALLS" "awk -v s='[blot-b2-storage]'"
[ ! -e "$W/storage-offsite.new" ] && ok "nor a bucket file" || fail "an empty storage offsite bucket file was written"
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
STUB_NEW_HAS_B2=1 run --production app old new
lacks "it doesn't add the offsite profile twice" "$CALLS" "awk -v s="
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
STUB_NEW_HAS_B2_CREDS=1 run --production app old new
has "a half-finished copy of the profile is completed" "$CALLS" "awk -v s='[profile blot-b2]'"
lacks "without repeating the half that is there" "$CALLS" "awk -v s='[blot-b2]'"
has "each on a line of its own" "$CALLS" "{ echo; cat; }"
ready_for_switch
echo None > "$W/tag"; rm "$W/units.new"
STUB_NO_BACKUP_KEY=1 run --production app old new
refused "production stops when the new host could not back up"
has "and says what to do" "$OUT" "AWS credentials"

ready_for_switch
rm "$W/units.new"
echo "ghcr.io/blotcms/blot:latest" > "$W/image.old"
run --drill app old new
refused "an image with no commit is refused"

# ---- switch --------------------------------------------------------------

SWITCH=(--drill --eip eipalloc-0a --bans-file "$BANS")
echo "# switch: refusals"
ready_for_switch
run --drill --bans-file "$BANS" switch old new
refused "no --eip is refused"
run --drill --eip eipalloc-0a switch old new
refused "no --bans-file is refused"
run --drill --eip nonsense --bans-file "$BANS" switch old new
refused "a malformed --eip is refused"
run --drill --eip eipalloc-0a --bans-file "$TMP/tree/bans.txt" switch old new
refused "a bans file git would track is refused"
has "and says why" "$OUT" "not ignored by git"
echo i-0production > "$W/eip_id"
run "${SWITCH[@]}" switch old new
refused "an Elastic IP on some other instance is refused"
no_changes "EIP elsewhere"
ready_for_switch
run "${SWITCH[@]}" switch eipalias new
refused "<old> as an alias of the Elastic IP is refused"
has "and says what to pass" "$OUT" "--old-direct"
no_changes "EIP alias"
rm "$W/paused.new"
run "${SWITCH[@]}" switch old new
refused "deploys not paused is refused"
ready_for_switch
rm "$W/units.new"
run "${SWITCH[@]}" switch old new
refused "new units down is refused"
no_changes "no units"
ready_for_switch
STUB_STATIC=404 run "${SWITCH[@]}" switch old new
refused "static files missing on the new host is refused"
has "and says so" "$OUT" "layout.css"
no_changes "static files missing"
ready_for_switch
echo "ghcr.io/blotcms/blot:2222222222222222222222222222222222222222" > "$W/image.new"
run "${SWITCH[@]}" switch old new
refused "a different image is refused"
ready_for_switch
STUB_PROMOTE_PRECHECK_FAILS=1 run "${SWITCH[@]}" --yes switch old new
refused "promote.sh's own checks stop it before the freeze"
lacks "nothing frozen" "$CALLS" "read-only.js on"

echo "# switch"
ready_for_switch
run "${SWITCH[@]}" switch old new
refused "without --yes and without a terminal it asks and stops"
no_changes "no answer"
run "${SWITCH[@]}" --dry-run switch old new
status_is "switch dry run works" 0
no_changes "switch dry run"
has "and prints the move" "$OUT" "would run: aws_cli ec2 associate-address"
lacks "with no promotion" "$CALLS" "promote.sh --yes"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias new
status_is "switch works" 0
has "the freeze goes on through the old host's units" "$CALLS" "ssh direct [old]: sudo docker exec blot-blue node scripts/read-only.js on --ttl 900 --reason 'host cycle'"
before "bans leave the old host first" "bans.sh export direct" "read-only.js on"
before "freeze, then promote" "read-only.js on --ttl 900" "promote.sh --yes direct new"
before "the locks, then promote" "ssh direct [old]: sudo docker exec blot-blue node scripts/read-only.js status" "promote.sh --yes direct new"
before "freeze, then the cache" "read-only.js on --ttl 900" "reset-cache.sh $OLD_SHA"
before "the cache, then promote" "reset-cache.sh $OLD_SHA" "promote.sh --yes direct new"
[ "$(printf '%s\n' "$CALLS" | grep -c "reset-cache.sh")" = 1 ] && ok "the cache is emptied once, not again after the promotion" ||
  fail "the cache is emptied $(printf '%s\n' "$CALLS" | grep -c "reset-cache.sh") times"
before "promote, then the Elastic IP" "promote.sh --yes direct new" "associate-address"
before "the Elastic IP, then the check through it" "associate-address" "--resolve blot.test:443:203.0.113.9"
before "the check, then unfreeze" "--resolve blot.test:443:203.0.113.9" "read-only.js off"
before "unfreeze, then the old units" "read-only.js off" "docker stop"
before "the old units, then the bans" "docker stop" "bans.sh import new"
lacks "no re-arm through the new host after the promotion" "$(printf '%s\n' "$CALLS" | sed -n '/promote.sh --yes direct new/,$p')" "ssh new [new]: sudo docker exec blot-blue node scripts/read-only.js on"
before "promote, then the markers" "promote.sh --yes direct new" "ssh new [new]: sudo touch /etc/blot-redis/active"
before "unfreeze, then the markers" "read-only.js off" "ssh new [new]: sudo touch /etc/blot-redis/active"
has "the old Redis loses its active marker" "$CALLS" "ssh direct [old]: sudo rm -f /etc/blot-redis/active"
has "the Elastic IP goes to the new instance" "$CALLS" "--allocation-id eipalloc-0a --instance-id $NEW_ID --allow-reassociation"
has "the old units stop through --old-direct" "$CALLS" "ssh direct [old]: sudo bash -c"
has "and any airlocks a host still has" "$CALLS" "docker ps --quiet --filter name=-airlock | xargs -r docker stop"
lacks "they are only stopped" "$CALLS" "docker rm"
has "the freeze goes through the new host" "$CALLS" "ssh new [new]: sudo docker exec blot-blue node scripts/read-only.js off"
has "ssh to the new host follows the Elastic IP once it moved" "$(cat "$W/override_calls")" "read-only.js off"
lacks "and not before (the roles are read first)" "$(cat "$W/override_calls")" "INFO replication"
has "through a config naming the Elastic IP" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
has "and checking the key as known_hosts spells it" "$(cat "$W/override_cfg")" "HostKeyAlias [192.0.2.20]:2222"
has "over the user's own config" "$(cat "$W/override_cfg")" "Include $HOME/.ssh/config"
[ ! -e "$W/frozen" ] && ok "nothing is frozen at the end" || fail "still frozen"

echo "# switch: a master that was not promoted by this cycle"
ready_for_switch
echo master > "$W/role.new"; echo 100 > "$W/keys.new"
run "${SWITCH[@]}" --yes switch old new
refused "a master the old Redis does not follow is refused"
has "and says so" "$OUT" "does not follow"
lacks "nothing frozen" "$CALLS" "read-only.js on"
lacks "nothing promoted" "$CALLS" "promote.sh --yes"
# promote.sh finished FAILOVER but died before writing its marker.
echo slave > "$W/role.old"; echo 10.0.0.2 > "$W/master.old"
touch "$W/flaky_move"
run "${SWITCH[@]}" --yes switch old new
rm -f "$W/flaky_move" "$W/ssh_resets"
status_is "a master the old Redis follows resumes, past resets after the address moves" 0
lacks "with no second freeze" "$CALLS" "[old]: sudo docker exec blot-blue node scripts/read-only.js on"
lacks "and no second promotion" "$CALLS" "promote.sh --yes"
has "and writes the markers promote.sh did not" "$CALLS" "ssh new [new]: sudo touch /etc/blot-redis/active"
has "on both sides" "$CALLS" "sudo rm -f /etc/blot-redis/active"
has "and moves the Elastic IP" "$CALLS" "associate-address"

echo "# switch: run again"
rm -f "$W/override_cfg" "$W/override_calls"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias new
status_is "a finished switch runs again" 0
has "a resumed switch follows the Elastic IP too" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
rm -f "$W/override_cfg" "$W/override_calls"
touch "$W/launch_released"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias new
status_is "with <new>'s launch address released, --old-direct still reaches the old host" 0
has "by following the Elastic IP before the first probe" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
rm -f "$W/launch_released" "$W/override_cfg" "$W/override_calls"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias newip
status_is "with <new> already the Elastic IP it runs" 0
[ ! -e "$W/override_cfg" ] && ok "and overrides nothing" || fail "an override for an alias that is already the Elastic IP"
rm -f "$W/override_cfg" "$W/override_calls"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias new
has "and says it is done" "$OUT" "has finished"
no_changes "a finished switch"

echo "# switch: stops and resumes"
ready_for_switch
STUB_LOCKS=1 run "${SWITCH[@]}" --yes switch old new
refused "folder locks that never go stop it"
has "it names the stage" "$OUT" "stopped during: freeze"
has "and says why" "$OUT" "folder locks still held"
lacks "no promotion" "$CALLS" "promote.sh --yes"
has "the freeze is lifted on the old host" "$CALLS" "ssh old [old]: sudo docker exec blot-blue node scripts/read-only.js off"
has "and it says so" "$OUT" "the freeze is lifted"
[ ! -e "$W/frozen" ] && ok "nothing is left frozen" || fail "still frozen after a failed freeze"
ready_for_switch
touch "$W/frozen"
STUB_FREEZE_REASON=maintenance run "${SWITCH[@]}" --yes switch old new
refused "someone else's freeze stops it"
has "and says so" "$OUT" "read-only for something else"
lacks "it is not extended" "$CALLS" "read-only.js on"
lacks "or lifted" "$CALLS" "read-only.js off"
lacks "no promotion" "$CALLS" "promote.sh --yes"
ready_for_switch
touch "$W/frozen"
run "${SWITCH[@]}" --yes switch old new
status_is "its own freeze from an interrupted run goes on" 0
has "and promotes" "$CALLS" "promote.sh --yes old new"
ready_for_switch
ready_for_switch
STUB_PROMOTE_FAILS=1 run "${SWITCH[@]}" --yes switch old new
refused "a failed promotion stops it"
has "it names the stage" "$OUT" "stopped during: promotion"
lacks "the Elastic IP stays" "$CALLS" "associate-address"
run "${SWITCH[@]}" --yes switch old new
status_is "and it resumes" 0
ready_for_switch
touch "$W/down.old"
run "${SWITCH[@]}" --yes switch old new
refused "an old host that cannot be reached stops it first"
no_changes "old unreachable"
rm "$W/down.old"
run "${SWITCH[@]}" --yes switch old new
ready_for_switch
# The check through the Elastic IP fails after the move.
STUB_PROBE=502 run "${SWITCH[@]}" --yes switch old new
refused "a failed check through the Elastic IP stops it"
has "it says what to do" "$OUT" "promote.sh new old"
lacks "still frozen, for a person to decide" "$CALLS" "read-only.js off"
[ -e "$W/frozen" ] && ok "the app stays frozen" || fail "unfrozen after a failed check"
run "${SWITCH[@]}" --yes --old-direct direct switch eipalias new
status_is "it resumes through --old-direct" 0
lacks "with no second freeze" "$CALLS" "[old]: sudo docker exec blot-blue node scripts/read-only.js on"
lacks "no second promotion" "$CALLS" "promote.sh --yes"
lacks "no second cache wipe" "$CALLS" "reset-cache.sh"
lacks "no second move" "$CALLS" "associate-address"
has "and finishes" "$CALLS" "read-only.js off"
# An alias of the Elastic IP now reaches the new host.
run "${SWITCH[@]}" --yes switch eipalias new
refused "resuming with <old> as an alias that now reaches the new host is refused"
has "and says why" "$OUT" "same instance"
lacks "and nothing stops on the new host" "$CALLS" "docker stop"

# ---- settle --------------------------------------------------------------

echo "# settle"
ready_for_switch
run --drill settle old new
refused "settle needs --eip"
run --drill --eip eipalloc-0a settle old new
refused "settle before the switch is refused"
lacks "no deploy" "$CALLS" "units.sh"
run "${SWITCH[@]}" --yes switch old new
run --drill --eip eipalloc-0a --dry-run settle old new
status_is "settle dry run works" 0
lacks "settle dry run changes nothing" "$CALLS" "units.sh"
[ -e "$W/paused.new" ] && ok "settle dry run leaves the pause" || fail "the pause went"
STUB_UNITS_FAIL=1 run --drill --eip eipalloc-0a settle old new
refused "a failed rolling deploy stops settle"
[ -e "$W/paused.new" ] && ok "and deploys stay paused" || fail "deploys resumed after a failed settle"
rm -f "$W/override_cfg"
run --drill --eip eipalloc-0a settle old new
status_is "settle works" 0
has "settle follows the Elastic IP without the alias being edited" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
has "a forced rolling deploy of the same image" "$CALLS" "units.sh $OLD_SHA target=new ignore_pause=1 force=1 skip_write="
has "the dashboard is checked" "$CALLS" "https://blot.test/sites/log-in"
before "deploy, then deploys resume" "units.sh" "rm -f /etc/blot/deploy-paused"
lacks "no volumes to retag" "$CALLS" "create-tags"
[ ! -e "$W/paused.new" ] && [ ! -e "$W/paused.old" ] && ok "deploys resume on both hosts" || fail "still paused"
run --drill --eip eipalloc-0a settle old new
status_is "settle runs again" 0
lacks "with no second deploy" "$CALLS" "units.sh"

# ---- finish --------------------------------------------------------------

echo "# finish"
FINISH=(--drill --eip eipalloc-0a)
run --drill --eip eipalloc-0a finish old new
refused "finish without IDs is refused"
has "and says so" "$OUT" "--old-instance"
run "${FINISH[@]}" --old-volume vol-old --old-instance i-0aaa --yes finish old new
refused "--old-volume is gone: there is no data volume"
lacks "and nothing is terminated" "$CALLS" "terminate-instances"
run "${FINISH[@]}" --old-instance "$NEW_ID" --yes finish old new
refused "the new host cannot be terminated"
lacks "nothing is" "$CALLS" "terminate-instances"
run "${FINISH[@]}" --old-instance nonsense --yes finish old new
refused "something that is not an instance ID is refused"
echo True > "$W/protection"
run "${FINISH[@]}" --old-instance i-0aaa --old-instance i-0bbb --yes finish old new
refused "termination protection stops it"
has "with the command for the maintainer" "$OUT" "--no-disable-api-termination"
lacks "which it does not run" "$CALLS" "modify-instance-attribute"
lacks "and it terminates nothing" "$CALLS" "terminate-instances"
echo False > "$W/protection"
run "${FINISH[@]}" --old-instance i-0aaa --dry-run finish old new
status_is "finish dry run works" 0
lacks "and terminates nothing" "$CALLS" "terminate-instances"
run "${FINISH[@]}" --old-instance i-0aaa --old-instance i-0bbb finish old new
refused "without --yes it asks"
lacks "and stops" "$CALLS" "terminate-instances"
run "${FINISH[@]}" --old-instance i-0aaa --old-instance i-0bbb --yes finish old new
status_is "finish works" 0
has "it terminates the first" "$CALLS" "terminate-instances --instance-ids i-0aaa"
has "and the second" "$CALLS" "terminate-instances --instance-ids i-0bbb"
lacks "and touches no volume" "$CALLS" "volume"
touch "$W/paused.new"
run "${FINISH[@]}" --old-instance i-0aaa --yes finish old new
refused "before settle finish refuses"
rm "$W/paused.new"

# ---- restore -------------------------------------------------------------

echo "# restore"
COMMIT_SHA=2222222222222222222222222222222222222222
INPUTS=(--type m6gd.xlarge --cycle t1 --eip eipalloc-0a --commit "$COMMIT_SHA"
  --secrets-env "$TMP/in/secrets.env" --proxy-env "$TMP/in/proxy.env" --aws-credentials "$TMP/in/credentials")
# restore_world: the lost host is gone, whose address the Elastic IP is still on.
restore_world() { world; rm -rf "$W/units.old" "$W/etc.new"; mkdir -p "$W/etc.new"; }
no_volumes() { # restore makes, attaches and tags no volume, whatever else happens
  lacks "$1: no snapshot is read" "$CALLS" "describe-snapshots"
  lacks "$1: no volume is made" "$CALLS" "create-volume"
  lacks "$1: none is attached" "$CALLS" "attach-volume"
  lacks "$1: no tags" "$CALLS" "create-tags"
}

restore_world
run --drill "${INPUTS[@]}" --commit abc --dry-run restore
refused "restore with a short commit is refused"
run --drill "${INPUTS[@]}" --cycle "" --dry-run restore
refused "restore without a cycle name is refused"
run --drill "${INPUTS[@]}" --secrets-env "$TMP/in/missing" restore
refused "restore without the env files is refused"
has "and says what to supply" "$OUT" "--secrets-env FILE"
run --drill "${INPUTS[@]}" --aws-credentials "$TMP/in/secrets.env" restore
refused "credentials without a [default] profile are refused"
run restore
refused "restore with neither --drill nor --production is refused"
for gone in "--old-volume vol-0a1b" "--snapshot snap-0a1" --wait-prewarm; do
  # shellcheck disable=SC2086
  run --drill "${INPUTS[@]}" $gone --dry-run restore
  refused "restore no longer takes ${gone%% *}"
done
run --production "${INPUTS[@]}" --yes restore new
refused "--production against a drill-tagged host is refused"
has "naming the tag" "$OUT" "tagged BlotDrill=true"
no_volumes "restore on the wrong world"

echo "# restore: first run launches"
restore_world
run --drill "${INPUTS[@]}" --root-gb 30 --yes restore
status_is "restore without a name launches" 0
has "launch.sh is told the cycle" "$CALLS" "BlotCycle=t1"
has "and the root disk size" "$CALLS" "--root-gb 30"
has "the host is set up" "$CALLS" "deploy.sh PUBLIC_IP=192.0.2.20"
lacks "and no Redis restore" "$CALLS" "restore.sh"
has "it says to run it again" "$OUT" "run the same restore command again"
no_volumes "launch"

echo "# restore: dry run"
restore_world
run --drill "${INPUTS[@]}" --dry-run restore new
status_is "restore dry run works" 0
lacks "restores no Redis" "$CALLS" "restore.sh"
lacks "starts no units" "$CALLS" "units.sh"
lacks "moves no address" "$CALLS" "associate-address"
has "but prints what it would do" "$OUT" "would run: aws_cli ec2 associate-address"

echo "# restore: a fresh Redis"
restore_world
echo 3 > "$W/keys.new"
export STUB_RESTORE_NOOP=1
run --drill "${INPUTS[@]}" --yes restore new
unset STUB_RESTORE_NOOP
refused "a Redis still fresh after restore.sh is refused"
has "restore.sh ran on the fresh Redis, which holds a few sampler keys" "$CALLS" "restore.sh --yes new latest"
has "and it says so" "$OUT" "looks fresh"
lacks "no units start on an unrestored Redis" "$CALLS" "units.sh"

echo "# restore: a drill"
restore_world
echo 3 > "$W/keys.new"
chmod 644 "$TMP/in/secrets.env" "$TMP/in/proxy.env"
run --drill "${INPUTS[@]}" --yes restore new
status_is "restore works" 0
has "the env files are private on the host whatever their mode here" "$(ls -l "$W/etc.new/secrets.env" "$W/etc.new/proxy.env" | cut -c1-10 | sort -u)" "-rw-------"
lacks "and none is world-readable" "$(ls -l "$W/etc.new/secrets.env" "$W/etc.new/proxy.env" | cut -c1-10)" "r--r--"
before "Redis is restored first" "restore.sh --yes new latest" "wildcard-cert.sh new"
before "the env files and certificate come before the units" "wildcard-cert.sh new" "units.sh $COMMIT_SHA"
before "the units come before the address moves" "units.sh $COMMIT_SHA" "associate-address"
lacks "deploy.sh does not run again: launch did it" "$CALLS" "deploy.sh PUBLIC_IP"
has "the units target the new host" "$CALLS" "target=new"
has "the host is marked to back up" "$CALLS" "touch /etc/blot-redis/active"
has "the credentials were installed" "$(ls "$W")" "creds.new"
has "and the time of each step" "$OUT" "timing: Redis from the backup took"
has "it says Redis is behind S3" "$OUT" "Redis is as of its backup"
lacks "and names no reconcile" "$OUT" "reconcile"
no_volumes "restore"

before "the Elastic IP is followed before the public check" "associate-address" "--resolve blot.test:443:203.0.113.9"
has "through a config naming the Elastic IP" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
has "it reminds to edit the alias" "$OUT" "Change HostName for new in ~/.ssh/config to 203.0.113.9"
[ ! -e "$W/etc.new/cycle-env-pending" ] && ok "the env marker is cleared once the units are verified" || fail "cycle-env-pending is still on the new host"

echo "# restore: again after it finished"
rm -f "$W/override_cfg"
touch "$W/gone.new"
run --drill "${INPUTS[@]}" --yes restore new
status_is "restore can be run again" 0
has "a resumed restore follows the Elastic IP before reaching the host" "$(cat "$W/override_cfg")" "HostName 203.0.113.9"
rm -f "$W/gone.new"
lacks "no second Redis restore" "$CALLS" "restore.sh"
lacks "the address is not moved again" "$CALLS" "associate-address"
has "it says where it is" "$OUT" "is already on"
no_volumes "second restore"

echo "# restore: env marker left by an interrupted run"
restore_world
echo 3 > "$W/keys.new"
touch "$W/etc.new/cycle-env-pending"
cp "$TMP/in/secrets.env" "$TMP/in/proxy.env" "$W/etc.new/"
run --drill "${INPUTS[@]}" --yes restore new
status_is "restore with the marker present works" 0
has "the units are redeployed by force" "$CALLS" "units.sh $COMMIT_SHA"
[ ! -e "$W/etc.new/cycle-env-pending" ] && ok "and the marker is cleared afterwards" || fail "the marker is still there"

echo "# restore: production"
restore_world
echo None > "$W/tag"
run --production "${INPUTS[@]}" --yes restore new
refused "the production address needs a person at the terminal, --yes or not"
has "and says why" "$OUT" "person at the terminal"
has "the units had come up" "$CALLS" "units.sh $COMMIT_SHA"
lacks "the address did not move" "$CALLS" "associate-address"
has "it names the host losing the address" "$OUT" "is on: i-06f6c64"
no_volumes "production restore"
echo true > "$W/tag"

# ---- status --------------------------------------------------------------

echo "# status"
ready_for_switch
run status old new
status_is "status needs no --drill" 0
has "it shows the replica" "$OUT" "slave"
has "and the pause" "$OUT" "deploys paused"
no_changes "status"
touch "$W/down.new"
run status old new
status_is "status survives a host it cannot reach" 0
has "and says so" "$OUT" "not reachable"
rm "$W/down.new"

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
