#!/bin/bash
# Runs config/host/host/setup.sh in Amazon Linux 2023 containers: with
# BLOT_HOST_SKIP_SYSTEMD=1 (the base image has no systemd), twice, then checks
# that the second run changed nothing and the result is what setup.sh promises.
# Also runs it in a real Amazon Linux 2 image, where it must refuse.
# The containers get NET_ADMIN so the test can load the real nftables file.
#
# Needs docker. Usage: config/host/tests/setup.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
NAME=blot-host-setup-test
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeyfortestsonlyxxxxxxxxxxxxxxxxxxxxxxxxx test@example.com"
FAILED=0

cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then ok "$what"; else fail "$what"; fi
}
in_ct() { docker exec "$NAME" bash -c "$1"; }
put_in_ct() { docker exec -i "$NAME" bash -c "cat > '$1' && chmod +x '$1'"; } # put_in_ct <path>, content on stdin
# A container has no instance metadata service, so the VPC range and interface are given.
FW_ENV=(-e BLOT_VPC_CIDR=10.0.0.0/16 -e BLOT_MAIN_INTERFACE=eth0)
start() { docker run -d --cap-add NET_ADMIN --name "$NAME" -v "$REPO:/repo:ro" "$1" sleep 3600 > /dev/null; }
setup() { # setup <output file>
  docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 -e BLOT_SSH_PORT=2222 -e "BLOT_DEPLOY_PUBLIC_KEY=$KEY" \
    -e REDIS_MAXMEMORY=1gb "${FW_ENV[@]}" "$NAME" bash /repo/config/host/host/setup.sh > "$1" 2>&1 ||
    { cat "$1"; fail "setup.sh exited non-zero"; return 1; }
}

# Files setup.sh manages, in one checksum.
sums() {
  in_ct 'sha256sum /etc/cron.d/blot-docker-health /etc/systemd/system/docker.service.d/30-redis.conf \
    /etc/ssh/sshd_config.d/11-blot-port.conf /etc/sysctl.d/91-blot-host.conf /etc/ssh/sshd_config \
    /home/deploy/.ssh/authorized_keys /etc/rsyslog.d/30-deploy-user.conf /etc/logrotate.d/deploy-user \
    /etc/nftables/blot-redis.nft /etc/systemd/system/blot-redis-firewall.service \
    /etc/systemd/system/redis6.service.d/zz-blot-firewall.conf /etc/blot-redis/shared-instance-store \
    /etc/redis6/redis6.conf /etc/redis6/blot-memory.conf /etc/cron.d/blot-redis /usr/local/bin/mount-instance-store.sh
    stat -c "%n %U:%G %a" /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static
    readlink /usr/local/bin/redis-cli; id -nG ec2-user deploy
    redis6-cli INFO server | grep process_id'
}

TMP=$(mktemp -d)
trap 'cleanup; rm -rf "$TMP"' EXIT

echo "# Amazon Linux 2023"
start amazonlinux:2023
# Test artifacts: the base image lacks these, a real AMI has them.
docker exec "$NAME" dnf install -y -q shadow-utils diffutils openssh-server util-linux > /dev/null
in_ct 'useradd -m ec2-user && ssh-keygen -A > /dev/null'

setup "$TMP/run1" || exit 1
setup "$TMP/run2" || exit 1
tail -n 12 "$TMP/run2"
check "first run installs things" grep -q 'updated /etc/cron.d/blot-docker-health' "$TMP/run1"
check "second run reports no updates" bash -c "! grep -q 'updated' '$TMP/run2'"
sums > "$TMP/sums1"
setup "$TMP/run3"
sums > "$TMP/sums2"
check "a third run leaves the managed files as they were" cmp -s "$TMP/sums1" "$TMP/sums2"

check "redis-cli resolves to redis6-cli" \
  in_ct '[ "$(readlink -f "$(command -v redis-cli)")" = "$(readlink -f /usr/bin/redis6-cli)" ]'
check "fail2ban-client and iptables exist" in_ct 'command -v fail2ban-client && command -v iptables'
check "firewalld is not installed" in_ct '! rpm -q firewalld'
check "docker is installed and not running" in_ct 'rpm -q docker && ! grep -lx dockerd /proc/[0-9]*/comm 2> /dev/null'
check "cron entry" in_ct '[ "$(grep -v "^#" /etc/cron.d/blot-docker-health)" = "* * * * * root /usr/local/bin/check_docker_health.sh >/dev/null 2>&1" ] &&
  [ "$(stat -c "%a %U:%G" /etc/cron.d/blot-docker-health)" = "644 root:root" ]'
check "docker drop-in" in_ct 'grep -qx "After=redis6.service" /etc/systemd/system/docker.service.d/30-redis.conf &&
  ! grep -qE "^(Wants|Requires)=" /etc/systemd/system/docker.service.d/30-redis.conf'
check "ec2-user and deploy are in the docker group" in_ct 'id -nG ec2-user | grep -qw docker && id -nG deploy | grep -qw docker'
check "deploy has the key" in_ct "grep -qxF '$KEY' /home/deploy/.ssh/authorized_keys"
check "directories are owned by ec2-user" in_ct '
  for d in /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static; do
    [ "$(stat -c %U:%G "$d")" = ec2-user:ec2-user ] || exit 1
  done'
check "nothing under /var/instance-ssd" in_ct '[ ! -e /var/instance-ssd ]'
check "sysctl file" in_ct 'grep -qx "net.ipv4.tcp_migrate_req = 1" /etc/sysctl.d/91-blot-host.conf'
check "the deploy rsyslog rule lets lines through to /var/log/secure" in_ct '! grep -q "^& stop" /etc/rsyslog.d/30-deploy-user.conf'
check "sshd -t passes with the port drop-in" in_ct 'sshd -t && sshd -T | grep -qx "port 2222"'
# The Redis setup writes 10-blot.conf only outside skip mode, so it is still absent here.
check "the port drop-in is separate from 10-blot.conf" in_ct '[ ! -e /etc/ssh/sshd_config.d/10-blot.conf ]'

echo "# Redis"
check "the shared instance store marker exists" in_ct '[ -f /etc/blot-redis/shared-instance-store ]'
check "Redis answers" in_ct 'redis6-cli PING | grep -qx PONG'
check "maxmemory is REDIS_MAXMEMORY" in_ct '[ "$(redis6-cli CONFIG GET maxmemory | sed -n 2p)" = 1073741824 ]'
check "the second run found Redis running and left it" grep -q 'already running: not restarting it' "$TMP/run2"
docker exec -e BLOT_REDIS_SKIP_SYSTEMD=1 -e REDIS_MAXMEMORY=1gb "$NAME" bash /repo/config/redis/host/setup.sh > "$TMP/redis-alone" 2>&1 ||
  fail "the Redis setup alone exited non-zero"
check "a Redis setup run without the variable keeps the marker" in_ct '[ -f /etc/blot-redis/shared-instance-store ]'

echo "# Firewall"
check "the nft file replaces only its own table" in_ct '
  f=/etc/nftables/blot-redis.nft
  [ "$(grep -v "^[[:space:]]*#" $f | sed -n 1,2p)" = "table inet blot_redis
delete table inet blot_redis" ] && ! grep -q "flush ruleset" $f &&
  grep -qF "iifname \"eth0\" ip saddr 10.0.0.0/16 tcp dport 6379 accept" $f'
check "the unit loads the file and redis6 requires the unit" in_ct '
  u=/etc/systemd/system/blot-redis-firewall.service
  d=/etc/systemd/system/redis6.service.d/zz-blot-firewall.conf
  grep -qx "ExecStart=/usr/sbin/nft -f /etc/nftables/blot-redis.nft" $u &&
  grep -qx "Before=network-pre.target redis6.service shutdown.target" $u &&
  grep -qx "Requires=blot-redis-firewall.service" $d && grep -qx "After=blot-redis-firewall.service" $d'
# fail2ban and docker keep their rules in the same nftables: loading the file again and again must not touch them.
in_ct 'nft add table inet other_owner && nft add chain inet other_owner c "{ type filter hook input priority 10; }"' ||
  fail "could not create a table (the container needs NET_ADMIN)"
in_ct 'nft -f /etc/nftables/blot-redis.nft && nft -f /etc/nftables/blot-redis.nft' || fail "could not load the nft file"
check "another table survives two loads" in_ct 'nft list table inet other_owner > /dev/null'
check "there is one blot_redis table after two loads" in_ct '[ "$(nft list tables | grep -c blot_redis)" = 1 ]'
check "the rules accept lo and the VPC, then drop the rest" in_ct '
  r=$(nft list chain inet blot_redis input)
  echo "$r" | grep -q "priority filter - 10" &&
  [ "$(echo "$r" | grep -E "iifname " | sed "s/^[[:space:]]*//")" = "iifname \"lo\" accept
iifname \"eth0\" ip saddr 10.0.0.0/16 tcp dport 6379 accept" ] &&
  [ "$(echo "$r" | grep -c "tcp dport 6379 drop")" = 1 ] &&
  [ "$(echo "$r" | grep -n "tcp dport 6379 drop" | cut -d: -f1)" -gt "$(echo "$r" | grep -n "ip saddr" | cut -d: -f1)" ]'
check "Redis still answers over loopback with the rules loaded" in_ct 'redis6-cli PING | grep -qx PONG'

echo "# mount-instance-store.sh on a combined host"
# Stubs for what needs a real disk or root-owned mounts; every call is logged to /tmp/calls.
in_ct 'mkdir -p /tmp/stubs'
for c in mount mkfs; do printf '#!/bin/sh\necho "%s $*" >> /tmp/calls\n[ "%s" != mount ] || { for a; do l=$a; done; echo "$l" >> /tmp/mounted; }\n' "$c" "$c" | put_in_ct /tmp/stubs/$c; done
printf '#!/bin/sh\necho "blkid $*" >> /tmp/calls\nexit 1\n' | put_in_ct /tmp/stubs/blkid
printf '#!/bin/sh\necho "nvme $*" >> /tmp/calls\necho "/dev/nvme1n1 SN Amazon EC2 NVMe Instance Storage 1"\n' | put_in_ct /tmp/stubs/nvme
printf '#!/bin/sh\n[ "$1" = -q ] && shift\ngrep -qx "$1" /tmp/mounted 2> /dev/null\n' | put_in_ct /tmp/stubs/mountpoint
printf '#!/bin/sh\nPATH=/tmp/stubs:$PATH sh /usr/local/bin/mount-instance-store.sh\n' | put_in_ct /tmp/run-mis
check "refuses when /var/instance-ssd is not mounted" bash -c "! docker exec $NAME bash -c 'rm -f /tmp/calls /tmp/mounted; /tmp/run-mis' > '$TMP/mis1' 2>&1"
check "and says so, and mounts nothing" bash -c "grep -q '/var/instance-ssd is not mounted' '$TMP/mis1' && ! docker exec $NAME test -e /tmp/calls"
check "bind-mounts a directory of the instance store at /backups" in_ct '
  rm -f /tmp/calls; echo /var/instance-ssd > /tmp/mounted; /tmp/run-mis > /dev/null &&
  [ "$(cat /tmp/calls)" = "mount --bind /var/instance-ssd/redis-backups /backups" ] &&
  [ "$(stat -c %U:%G /var/instance-ssd/redis-backups)" = ec2-user:ec2-user ]'
check "and never calls nvme, blkid or mkfs" in_ct '! grep -qE "^(nvme|blkid|mkfs)" /tmp/calls'
check "mounts nothing more when /backups is mounted already" in_ct 'rm -f /tmp/calls; /tmp/run-mis > /dev/null && [ ! -e /tmp/calls ]'
check "without the marker it takes the old path: nvme, blkid, mkfs, mount" in_ct '
  m=/etc/blot-redis/shared-instance-store
  mv $m /tmp/marker; rm -f /tmp/calls /tmp/mounted; /tmp/run-mis > /dev/null 2>&1; mv /tmp/marker $m
  grep -q "^nvme" /tmp/calls && grep -q "^blkid" /tmp/calls && grep -q "^mkfs" /tmp/calls &&
  grep -qx "mount /dev/nvme1n1 /backups" /tmp/calls'

echo "# bootstrap.sh"
# A stub ssh and sudo, so the real tar pipe and quoting reach the container.
mkdir "$TMP/bin"
cat > "$TMP/bin/ssh" <<EOF
#!/bin/bash
while [ "\$1" = -o ]; do shift 2; done
shift
exec docker exec -i -e BLOT_HOST_SKIP_SYSTEMD=1 -e BLOT_VPC_CIDR=10.0.0.0/16 -e BLOT_MAIN_INTERFACE=eth0 $NAME bash -c "\$*"
EOF
chmod +x "$TMP/bin/ssh"
in_ct 'dnf install -y -q tar > /dev/null && printf "#!/bin/bash\nexec \"\$@\"\n" > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo'
check "bootstrap.sh refuses without REDIS_MAXMEMORY, before copying anything" \
  bash -c "! env PATH='$TMP/bin:$PATH' bash '$REPO/config/host/bootstrap.sh' host > '$TMP/bootstrap-no' 2>&1 && grep -q REDIS_MAXMEMORY '$TMP/bootstrap-no'"
check "bootstrap.sh copies the files and runs setup.sh" \
  env PATH="$TMP/bin:$PATH" REDIS_MAXMEMORY=1gb BLOT_SSH_PORT=2222 BLOT_DEPLOY_PUBLIC_KEY="$KEY" \
  bash -c "'$REPO/config/host/bootstrap.sh' host > '$TMP/bootstrap' 2>&1"
check "the deploy-user script is found in the copied layout" in_ct '[ -f /tmp/blot-host/setup-deploy-user.sh ] && [ -f /tmp/blot-host/host/setup.sh ]'
check "the Redis files are copied in the layout its setup expects" in_ct '
  for f in redis.conf bin/backup.sh bin/tcpmem-log.sh host/setup.sh host/mount-instance-store.sh; do [ -f /tmp/blot-host/redis/$f ] || exit 1; done'
check "the key survives the remote shell's quoting" in_ct "[ \"\$(grep -c 'test@example.com' /home/deploy/.ssh/authorized_keys)\" = 1 ]"

echo "# Amazon Linux 2023 without the optional env"
cleanup
start amazonlinux:2023
docker exec "$NAME" dnf install -y -q shadow-utils diffutils util-linux > /dev/null
# host/setup.sh checks its inputs before it installs anything.
bare() { docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 "$@" "$NAME" bash /repo/config/host/host/setup.sh; } # bare <docker exec -e options>
nothing_installed() { in_ct '! rpm -q nftables && ! rpm -q docker && [ ! -e /etc/nftables ]'; }
if bare "${FW_ENV[@]}" > "$TMP/nomem" 2>&1; then fail "setup.sh ran without REDIS_MAXMEMORY"; else
  check "refuses without REDIS_MAXMEMORY" grep -q 'REDIS_MAXMEMORY is required' "$TMP/nomem"
fi
check "and installed nothing first" nothing_installed
if bare -e "REDIS_MAXMEMORY=10 gb" "${FW_ENV[@]}" > /dev/null 2>&1; then fail "setup.sh ran with a malformed REDIS_MAXMEMORY"; else ok "refuses a malformed REDIS_MAXMEMORY"; fi
# No metadata service in the container: a curl that fails like an unreachable one.
printf '#!/bin/sh\nexit 7\n' | put_in_ct /usr/local/bin/curl
if bare -e REDIS_MAXMEMORY=1gb > "$TMP/novpc" 2>&1; then fail "setup.sh ran without a VPC range"; else
  check "refuses when the VPC range cannot be determined" grep -q 'Could not determine the VPC CIDR' "$TMP/novpc"
fi
check "and installed nothing first" nothing_installed
if bare -e REDIS_MAXMEMORY=1gb -e "BLOT_VPC_CIDR=10.0.0.0/16 accept" -e BLOT_MAIN_INTERFACE=eth0 > /dev/null 2>&1; then
  fail "setup.sh ran with a malformed BLOT_VPC_CIDR"; else ok "refuses a malformed BLOT_VPC_CIDR"
fi
# A metadata service that answers like IMDSv2, and `ip` listing the MAC's interface.
put_in_ct /usr/local/bin/curl <<'EOF'
#!/bin/sh
case "$*" in
  *api/token*) echo token ;;
  *meta-data/mac) echo 02:aa:bb:cc:dd:ee ;;
  *vpc-ipv4-cidr-block) echo 10.1.0.0/16 ;;
  *) exit 22 ;;
esac
EOF
put_in_ct /usr/local/bin/ip <<'EOF'
#!/bin/sh
echo '1: lo: <LOOPBACK,UP> mtu 65536 state UNKNOWN mode DEFAULT qlen 1000\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00'
echo '2: ens5: <BROADCAST,MULTICAST,UP> mtu 9001 state UP mode DEFAULT qlen 1000\    link/ether 02:aa:bb:cc:dd:ee brd ff:ff:ff:ff:ff:ff'
echo '3: docker0: <NO-CARRIER> mtu 1500 state DOWN mode DEFAULT\    link/ether 02:42:00:00:00:01 brd ff:ff:ff:ff:ff:ff'
EOF
if bare -e REDIS_MAXMEMORY=1gb > "$TMP/bare" 2>&1; then ok "runs without ec2-user, a key or a port, reading the range and interface from the metadata"; else
  cat "$TMP/bare"; fail "setup.sh failed without ec2-user, a key or a port"
fi
check "the range and interface from the metadata are in the nft file" \
  in_ct 'grep -qF "iifname \"ens5\" ip saddr 10.1.0.0/16 tcp dport 6379 accept" /etc/nftables/blot-redis.nft'
check "no sshd drop-in without a port" in_ct '[ ! -e /etc/ssh/sshd_config.d/11-blot-port.conf ]'
check "bad port is refused" bash -c "! docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 -e 'BLOT_SSH_PORT=22 --x' $NAME bash /repo/config/host/host/setup.sh > /dev/null 2>&1"

echo "# Amazon Linux 2"
cleanup
docker run -d --name "$NAME" -v "$REPO:/repo:ro" amazonlinux:2 sleep 3600 > /dev/null
if docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 "$NAME" bash /repo/config/host/host/setup.sh > "$TMP/al2" 2>&1; then
  fail "setup.sh ran on Amazon Linux 2"
else
  check "refuses to run on Amazon Linux 2" grep -q 'Amazon Linux 2023 host, but this is' "$TMP/al2"
  check "changed nothing on Amazon Linux 2" in_ct '[ ! -e /etc/cron.d/blot-docker-health ] && ! rpm -q docker'
fi

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
