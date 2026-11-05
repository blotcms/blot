#!/bin/bash
# Runs config/host/host/setup.sh in Amazon Linux 2023 containers: with
# BLOT_HOST_SKIP_SYSTEMD=1 (the base image has no systemd), twice, then checks
# that the second run changed nothing and the result is what setup.sh promises.
# Also runs it in a real Amazon Linux 2 image, where it must refuse.
# The containers get NET_ADMIN so the test can load the real nftables files,
# and the host's cgroup namespace so the app firewall's system.slice is there
# (on a runner whose docker uses the systemd cgroup driver, as GitHub's does).
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
start() { docker run -d --cap-add NET_ADMIN --cgroupns host --name "$NAME" -v "$REPO:/repo:ro" "$1" sleep 3600 > /dev/null; }
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
    /etc/nftables/blot-app.nft /etc/systemd/system/blot-app-firewall.service \
    /etc/redis6/redis6.conf /etc/redis6/blot-memory.conf /etc/cron.d/blot-redis /usr/local/bin/mount-instance-store.sh \
    /etc/tmpfiles.d/blot-redis.conf /etc/systemd/journald.conf.d/zz-blot-host.conf \
    /etc/systemd/system/fail2ban.service.d/20-memory.conf \
    /usr/local/sbin/blot-sandbox-cgroup.sh /etc/systemd/system/blot-sandbox-cgroup.service \
    /usr/local/lib/blot-storage/offsite-lib.sh /usr/local/lib/blot-storage/offsite-sync.sh \
    /usr/local/lib/blot-storage/offsite-restore-test.sh /etc/systemd/system/blot-storage-offsite.service \
    /etc/systemd/system/blot-storage-offsite.timer /etc/logrotate.d/blot-storage-offsite
    stat -c "%n %U:%G %a" /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static /run/blot/redis
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

# A host set up before the data volume went away: the unit and the drop-in that
# gated docker on it. Skip mode has no systemctl, so only the files are checked.
in_ct 'touch /etc/systemd/system/mount-data-volume.service /etc/systemd/system/docker.service.d/20-data-volume.conf'
setup "$TMP/run4" || exit 1
check "the data volume unit and its docker drop-in are removed" in_ct '
  [ ! -e /etc/systemd/system/mount-data-volume.service ] && [ ! -e /etc/systemd/system/docker.service.d/20-data-volume.conf ]'
check "and nothing else about docker changed" in_ct '[ -f /etc/systemd/system/docker.service.d/30-redis.conf ]'
setup "$TMP/run5" || exit 1
check "removing them again is a no-op" bash -c "! grep -q 'removed mount-data-volume' '$TMP/run5'"

check "journald is capped and fail2ban has a memory limit" in_ct '
  grep -qx "SystemMaxUse=500M" /etc/systemd/journald.conf.d/zz-blot-host.conf &&
  grep -qx "MemoryMax=256M" /etc/systemd/system/fail2ban.service.d/20-memory.conf'

check "redis-cli resolves to redis6-cli" \
  in_ct '[ "$(readlink -f "$(command -v redis-cli)")" = "$(readlink -f /usr/bin/redis6-cli)" ]'
check "fail2ban-client and iptables exist" in_ct 'command -v fail2ban-client && command -v iptables'
check "firewalld is not installed" in_ct '! rpm -q firewalld'
check "sqlite3 is installed, for bans.sh export" in_ct 'command -v sqlite3'
check "rclone is installed, with the S3 and B2 backends, for the storage offsite sync" in_ct '
  rclone version > /dev/null && rclone help backends | grep -qw s3 && rclone help backends | grep -qw b2'
check "the storage offsite scripts are installed, and the unit runs the sync as ec2-user" in_ct '
  d=/usr/local/lib/blot-storage
  [ -x $d/offsite-sync.sh ] && [ -x $d/offsite-restore-test.sh ] && [ -f $d/offsite-lib.sh ] &&
  bash -n $d/offsite-sync.sh && bash -n $d/offsite-restore-test.sh &&
  u=/etc/systemd/system/blot-storage-offsite.service
  grep -qx "ExecStart=$d/offsite-sync.sh" $u && grep -qx "User=ec2-user" $u && grep -qx "MemoryMax=2G" $u && grep -qx "OOMPolicy=continue" $u &&
  grep -qx "StandardOutput=append:/home/ec2-user/storage-offsite.log" $u &&
  grep -qx "OnCalendar=\*-\*-\* 02:10:00 UTC" /etc/systemd/system/blot-storage-offsite.timer'
check "with no bucket file the sync is off and exits 0" in_ct '
  runuser -u ec2-user -- /usr/local/lib/blot-storage/offsite-sync.sh | grep -q "off (no bucket in /etc/blot/storage-offsite-bucket)"'
check "docker is installed and not running" in_ct 'rpm -q docker && ! grep -lx dockerd /proc/[0-9]*/comm 2> /dev/null'
check "cron entry" in_ct '[ "$(grep -v "^#" /etc/cron.d/blot-docker-health)" = "* * * * * root /usr/local/bin/check_docker_health.sh >> /home/ec2-user/docker-health-check.log 2>&1" ] &&
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
check "the sandbox cgroup service runs the script before docker, and the script sets the limits" in_ct '
  u=/etc/systemd/system/blot-sandbox-cgroup.service
  s=/usr/local/sbin/blot-sandbox-cgroup.sh
  grep -qx "Type=oneshot" $u && grep -qx "RemainAfterExit=yes" $u && grep -qx "Before=docker.service" $u &&
  grep -qx "ExecStart=$s" $u && [ -x $s ] && sh -n $s &&
  grep -qF "echo 512M > \"\$dir/memory.max\"" $s && grep -qF "echo 0 > \"\$dir/memory.swap.max\"" $s &&
  grep -qF "echo 256 > \"\$dir/pids.max\"" $s && grep -qF "echo 25 > \"\$dir/cpu.weight\"" $s &&
  grep -qF "controllers=\"+memory +pids +cpu\"" $s &&
  grep -qF "dir=\$tree/\$unit-browser" $s && grep -qF "echo 1G > \"\$dir/memory.max\"" $s &&
  grep -qF "echo 1 > \"\$dir/memory.oom.group\"" $s'
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
SOCK=/run/blot/redis/redis.sock
check "tmpfiles.d declares the socket directory, and setup created it for redis6" in_ct '
  [ "$(grep -v "^#" /etc/tmpfiles.d/blot-redis.conf)" = "d /run/blot/redis 0755 redis6 redis6 -" ] &&
  [ "$(stat -c "%U:%G %a" /run/blot/redis)" = "redis6:redis6 755" ]'
check "Redis serves the socket, mode 777" in_ct '[ -S '$SOCK' ] && [ "$(stat -c %a '$SOCK')" = 777 ]'
check "uid 1000 can PING through the socket" in_ct '
  [ "$(id -u ec2-user)" = 1000 ] && [ "$(runuser -u ec2-user -- redis6-cli -s '$SOCK' PING)" = PONG ]'
check "and the socket reaches the same Redis as TCP" in_ct '
  [ "$(redis6-cli -s '$SOCK' CONFIG GET maxmemory | sed -n 2p)" = 1073741824 ] &&
  [ "$(redis6-cli -h 127.0.0.1 -p 6379 PING)" = PONG ]'
# Every boot: /run is a tmpfs, so the directory is gone until tmpfiles.d makes it again.
# With the app's file for /run/blot, in either order, as on a combined host.
check "tmpfiles recreates the directory, with the app's file before or after" in_ct '
  mv /run/blot /run/blot.gone
  systemd-tmpfiles --create /etc/tmpfiles.d/blot-redis.conf /repo/config/host/tmpfiles.d/blot.conf &&
  [ "$(stat -c "%U:%G %a" /run/blot/redis)" = "redis6:redis6 755" ] &&
  [ "$(stat -c "%u:%g %a" /run/blot)" = "1000:1000 755" ] &&
  rm -rf /run/blot && systemd-tmpfiles --create /repo/config/host/tmpfiles.d/blot.conf &&
  systemd-tmpfiles --create /etc/tmpfiles.d/blot-redis.conf &&
  [ "$(stat -c "%U:%G %a" /run/blot/redis)" = "redis6:redis6 755" ] &&
  [ "$(stat -c "%u:%g %a" /run/blot)" = "1000:1000 755" ]'
in_ct 'rm -rf /run/blot; mv /run/blot.gone /run/blot' || fail "could not restore /run/blot"
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

echo "# Firewall for the app"
check "the app nft file replaces only its own table and keeps DNS to the VPC resolver" in_ct '
  f=/etc/nftables/blot-app.nft
  [ "$(grep -v "^[[:space:]]*#" $f | sed -n 1,2p)" = "table inet blot_app
delete table inet blot_app" ] && ! grep -q "flush ruleset" $f &&
  grep -qF "meta skuid 1000 socket cgroupv2 level 1 \"system.slice\" jump unit" $f &&
  grep -qF "ip daddr { 10.0.0.2, 169.254.169.253 } meta l4proto { tcp, udp } th dport 53 accept" $f'
check "the app firewall unit runs before docker" in_ct '
  u=/etc/systemd/system/blot-app-firewall.service
  grep -qx "ExecStart=/usr/sbin/nft -f /etc/nftables/blot-app.nft" $u &&
  grep -qx "Before=network-pre.target docker.service shutdown.target" $u'
# Needs the kernel's socket cgroupv2 match and this container in system.slice,
# as on the production host and GitHub's runners; Docker Desktop has neither.
if ! in_ct 'grep -q "^0::/system.slice/" /proc/self/cgroup && nft -c -f /etc/nftables/blot-app.nft 2> /dev/null'; then
  echo "skip - the app firewall's behaviour: no socket cgroupv2 match or not in system.slice here"
else
  in_ct 'nft -f /etc/nftables/blot-app.nft && nft -f /etc/nftables/blot-app.nft' || fail "could not load the app nft file"
  check "the other tables survive two loads of the app file" in_ct 'nft list table inet other_owner > /dev/null && nft list table inet blot_redis > /dev/null'
  # curl exits 7 when it could not connect: here, at once.
  as() { echo "setpriv --reuid $1 --regid $1 --clear-groups"; }
  check "uid 1000 is refused the metadata service at once" in_ct "$(as 1000) curl -s -m 3 http://169.254.169.254/latest/meta-data/; [ \$? = 7 ]"
  check "uid 1000 is refused private and IPv6 unique local addresses" in_ct "
    for u in http://10.255.255.1/ http://172.16.0.1/ http://192.168.0.1/ http://100.64.0.1/ 'http://[fd00:ec2::254]/'; do
      $(as 1000) curl -s -g -m 3 \"\$u\"; [ \$? = 7 ] || exit 1
    done"
  check "uid 1000 still reaches loopback" in_ct "$(as 1000) redis6-cli -h 127.0.0.1 PING | grep -qx PONG"
  check "other uids are not refused" in_ct "
    curl -s -m 1 http://10.255.255.1/; [ \$? != 7 ] && { $(as 1001) curl -s -m 1 http://10.255.255.1/; [ \$? != 7 ]; }"
fi

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
check "and the storage offsite scripts where setup.sh looks for them" in_ct '
  for f in offsite-lib.sh offsite-sync.sh offsite-restore-test.sh; do [ -f /tmp/blot-host/storage-bucket/bin/$f ] || exit 1; done'
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

echo "# Redis socket on a Redis-only host, and on a live Redis that predates it"
cleanup
start amazonlinux:2023
docker exec "$NAME" dnf install -y -q shadow-utils diffutils util-linux > /dev/null
in_ct 'useradd -m ec2-user'
redis_setup() { # redis_setup <setup.sh path> <output file>
  docker exec -e BLOT_REDIS_SKIP_SYSTEMD=1 -e REDIS_MAXMEMORY=1gb "$NAME" bash "$1" > "$2" 2>&1 ||
    { cat "$2"; fail "$1 exited non-zero"; return 1; }
}
# The Redis setup as it was: a copy of config/redis without the socket.
in_ct 'cp -r /repo/config/redis /tmp/old-redis && sed -i "/^unixsocket/d" /tmp/old-redis/redis.conf'
redis_setup /tmp/old-redis/host/setup.sh "$TMP/old" || exit 1
check "nothing else created /run/blot, and the old Redis has no socket" in_ct '
  [ "$(stat -c %U:%G /run/blot)" = root:root ] && [ ! -e '$SOCK' ] && [ "$(redis6-cli PING)" = PONG ]'
in_ct 'redis6-cli INFO server | grep process_id' > "$TMP/pid1"
redis_setup /repo/config/redis/host/setup.sh "$TMP/live" || exit 1
in_ct 'redis6-cli INFO server | grep process_id' > "$TMP/pid2"
check "setup on the live Redis leaves it running, same process" cmp -s "$TMP/pid1" "$TMP/pid2"
check "and lists the socket settings as needing a restart" bash -c "
  grep -q 'unixsocket: running' '$TMP/live' && grep -q 'unixsocketperm: running' '$TMP/live' &&
  grep -q 'Need a restart (not done)' '$TMP/live'"
check "the socket directory exists now, the socket does not yet" in_ct '
  [ "$(stat -c "%U:%G %a" /run/blot/redis)" = "redis6:redis6 755" ] && [ ! -e '$SOCK' ]'
check "running it again changes nothing" bash -c "
  docker exec -e BLOT_REDIS_SKIP_SYSTEMD=1 -e REDIS_MAXMEMORY=1gb $NAME bash /repo/config/redis/host/setup.sh > '$TMP/live2' 2>&1 &&
  ! grep -q updated '$TMP/live2' && grep -q 'unixsocket: running' '$TMP/live2'"
# What a restart does (systemd would do it with the unit): Redis starts from the installed config.
in_ct 'redis6-cli SHUTDOWN NOSAVE; sleep 1; runuser -u redis6 -- redis6-server /etc/redis6/redis6.conf --daemonize yes --supervised no'
for _ in $(seq 1 20); do in_ct 'redis6-cli PING' > /dev/null 2>&1 && break; sleep 0.5; done
check "after a restart Redis serves the socket" in_ct '[ -S '$SOCK' ] && [ "$(stat -c %a '$SOCK')" = 777 ]'
check "uid 1000 PINGs through it and TCP still answers" in_ct '
  [ "$(id -u ec2-user)" = 1000 ] && [ "$(runuser -u ec2-user -- redis6-cli -s '$SOCK' PING)" = PONG ] &&
  [ "$(redis6-cli -h 127.0.0.1 -p 6379 PING)" = PONG ]'
redis_setup /repo/config/redis/host/setup.sh "$TMP/live3" || exit 1
check "a rerun now finds nothing to restart" grep -q 'running settings match the new config' "$TMP/live3"

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
