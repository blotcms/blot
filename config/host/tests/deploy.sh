#!/bin/bash
# Runs config/host/deploy.sh against an Amazon Linux 2023 container where
# host/setup.sh has run, the way a new host is built. ssh and scp are stubs that
# reach the container; the container has no systemd, so systemctl, mountpoint,
# mount, nvme and blkid are stubs too (systemctl start mount-instance-store runs
# the real mount-instance-store.sh against them, and systemctl restart rsyslog
# restarts the real rsyslogd). Everything else is real: sshd, fail2ban,
# logrotate, rsyslog, install, sed. host/setup.sh sets up Redis too, so this is
# a combined host: blot-instance-store.service (Redis's /backups) is started by
# deploy.sh once the instance store is mounted.
#
# Needs docker. Usage: config/host/tests/deploy.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
NAME=blot-host-deploy-test
FAILED=0

TMP=$(mktemp -d)
cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap 'cleanup; rm -rf "$TMP"' EXIT
cleanup

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then ok "$what"; else fail "$what"; fi
}
in_ct() { docker exec "$NAME" bash -c "$1"; }
deploy() { # deploy <output file> [VAR=value...]
  local out=$1
  shift
  env PATH="$TMP/bin:$PATH" SSH_KEY=unused PUBLIC_IP=host SSH_PORT=2222 "$@" \
    bash "$REPO/config/host/deploy.sh" > "$out" 2>&1 || { tail -20 "$out"; return 1; }
}

docker run -d --cap-add NET_ADMIN --name "$NAME" -v "$REPO:/repo:ro" amazonlinux:2023 sleep 3600 > /dev/null
# Test artifacts: the base image lacks these, a real AMI has them.
docker exec "$NAME" dnf install -y -q shadow-utils diffutils openssh-server tar systemd util-linux > /dev/null
in_ct 'useradd -m ec2-user && ssh-keygen -A > /dev/null'
docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 -e BLOT_SSH_PORT=2222 -e REDIS_MAXMEMORY=1gb -e BLOT_VPC_CIDR=10.0.0.0/16 -e BLOT_MAIN_INTERFACE=eth0 "$NAME" bash /repo/config/host/host/setup.sh > "$TMP/setup" 2>&1 ||
  { cat "$TMP/setup"; fail "setup.sh exited non-zero"; }

# Stubs for ssh and scp on this side, and for what needs systemd or a real
# disk in the container.
mkdir "$TMP/bin"
cat > "$TMP/bin/ssh" <<EOS
#!/bin/bash
while [[ \$1 == -* ]]; do shift 2; done
shift
exec docker exec -i $NAME bash -c "\$*"
EOS
cat > "$TMP/bin/scp" <<EOS
#!/bin/bash
while [[ \$1 == -* ]]; do if [ "\$1" = -r ]; then shift; else shift 2; fi; done
exec docker cp "\$1" "$NAME:\${2#*:}"
EOS
chmod +x "$TMP/bin/ssh" "$TMP/bin/scp"
in_ct 'cd /usr/local/bin
printf "#!/bin/bash\nexec \"\$@\"\n" > sudo
printf "#!/bin/bash\necho \"\$*\" >> /tmp/systemctl.log\n[ \"\$*\" != \"start mount-instance-store.service\" ] || bash /home/ec2-user/scripts/mount-instance-store.sh\n[ \"\$*\" != \"start blot-instance-store.service\" ] || bash /usr/local/bin/mount-instance-store.sh\n" > systemctl
printf "#!/bin/bash\n[ \"\$1\" = -q ] && shift\ngrep -qx \"\$1\" /tmp/mounted 2> /dev/null\n" > mountpoint
printf "#!/bin/bash\necho \"\${@: -1}\" >> /tmp/mounted\necho \"mount \$*\" >> /tmp/mount.log\n" > mount
printf "#!/bin/bash\necho \"/dev/nvme1n1 SN Amazon EC2 NVMe Instance Storage 1\"\n" > nvme
printf "#!/bin/bash\nexit 0\n" > blkid
chmod +x sudo systemctl mountpoint mount nvme blkid
cat >> systemctl <<"EOF"
if [ "$*" = "restart rsyslog" ]; then
  [ ! -f /run/rsyslogd.pid ] || { kill "$(cat /run/rsyslogd.pid)"; while [ -f /run/rsyslogd.pid ]; do sleep 0.1; done; }
  # as systemd starts it: rsyslog.service has UMask=0066
  (umask 0066; rsyslogd)
fi
EOF'

echo "# A new host: no instance store mounted"
# Skip mode writes no units; the real one exists on a host set up with systemd.
in_ct 'touch /etc/systemd/system/blot-instance-store.service'
check "deploy.sh runs to the end" deploy "$TMP/run1"
check "deploy.sh says so" grep -q '^Host setup complete' "$TMP/run1"
check "the instance store unit is enabled" in_ct 'grep -qx "enable mount-instance-store.service" /tmp/systemctl.log'
check "the instance store unit is started when not mounted" in_ct '[ "$(grep -cx "start mount-instance-store.service" /tmp/systemctl.log)" = 1 ]'
check "the Redis backup unit is started after the instance store, when /backups is not mounted" in_ct '
  [ "$(grep -cx "start blot-instance-store.service" /tmp/systemctl.log)" = 1 ] &&
  [ "$(grep -nx "start mount-instance-store.service" /tmp/systemctl.log | cut -d: -f1)" -lt "$(grep -nx "start blot-instance-store.service" /tmp/systemctl.log | cut -d: -f1)" ]'
check "/backups is a bind mount of a directory on the instance store" in_ct '
  grep -qx "mount --bind /var/instance-ssd/redis-backups /backups" /tmp/mount.log && grep -qx /backups /tmp/mounted &&
  [ "$(stat -c %U:%G /var/instance-ssd/redis-backups)" = ec2-user:ec2-user ]'
check "docker is never started, restarted or stopped" in_ct '! grep -E "(start|stop|restart).* docker" /tmp/systemctl.log'
check "logs, tmp and disk-cache are owned by uid 1000" in_ct '
  for d in logs tmp disk-cache; do [ "$(stat -c %u:%g /var/instance-ssd/$d)" = 1000:1000 ] || exit 1; done'
check "every logpath in jail.local exists" in_ct '
  paths=$(sed -n "s/^[[:space:]]*logpath[[:space:]]*=[[:space:]]*//p" /etc/fail2ban/jail.local | sort -u)
  echo "$paths" | tr "\n" " "
  [ -n "$paths" ] && for p in $paths; do [ -e "$p" ] || exit 1; done'
check "the access log is owned by uid 1000" in_ct '[ "$(stat -c %u:%g /var/instance-ssd/logs/access.log)" = 1000:1000 ]'
check "rsyslog runs with the app log config and listens on its socket" in_ct '
  [ -f /etc/rsyslog.d/blot-app-log.conf ] && grep -qx "restart rsyslog" /tmp/systemctl.log && [ -S /run/blot-log/app.sock ]'
check "a unit's line on the socket lands in app.log with its tag" in_ct '
  logger -u /run/blot-log/app.sock -i -t blot-blue/abc1234 "[blue/node-a] hello from the unit"
  for i in $(seq 20); do grep -q " blot-blue/abc1234 \[blue/node-a\] hello from the unit$" /var/instance-ssd/logs/app.log 2> /dev/null && exit 0; sleep 0.2; done
  cat /var/instance-ssd/logs/app.log; exit 1'
check "ec2-user, whom read.sh connects as, can read app.log" in_ct '
  [ "$(stat -c %U /var/instance-ssd/logs/app.log)" = ec2-user ] && runuser -u ec2-user -- head -c 1 /var/instance-ssd/logs/app.log > /dev/null'
check "docker starts after rsyslog at boot" in_ct 'grep -qx "After=rsyslog.service" /etc/systemd/system/docker.service.d/20-rsyslog.conf'
check "app.log is rotated" in_ct 'logrotate --debug /etc/logrotate.d/app-log 2>&1 | grep -q "/var/instance-ssd/logs/app.log"'
check "fail2ban accepts the deployed config" in_ct 'fail2ban-client -t'
check "fail2ban was restarted" in_ct 'grep -qx "restart fail2ban" /tmp/systemctl.log'
check "sshd -T reports x11forwarding no" in_ct 'sshd -T | grep -qx "x11forwarding no"'
check "the port drop-in is untouched" in_ct 'sshd -T | grep -qx "port 2222" && [ -f /etc/ssh/sshd_config.d/11-blot-port.conf ] && [ ! -e /etc/ssh/sshd_config.d/10-blot.conf ]'
# The real sshd, started after the deploy so it reads the deployed config, and a
# real ssh and scp to it: the deployed .bashrc runs for them, and anything it
# writes shows up in the output.
in_ct 'dnf install -y -q openssh-clients > /dev/null; mkdir -p /run/sshd /home/ec2-user/.ssh
ssh-keygen -q -t ed25519 -N "" -f /home/ec2-user/.ssh/id; cp /home/ec2-user/.ssh/id.pub /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user: /home/ec2-user/.ssh; chmod 600 /home/ec2-user/.ssh/authorized_keys; echo data > /tmp/f
/usr/sbin/sshd'
remote() { # remote <command...>: as ec2-user, over ssh and then scp, printing everything they print
  in_ct "o='-q -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/ec2-user/.ssh/id'
    runuser -u ec2-user -- ssh \$o ec2-user@localhost true 2>&1
    runuser -u ec2-user -- scp \${o/-p/-P} /tmp/f ec2-user@localhost:/tmp/f2 2>&1 && cmp /tmp/f /tmp/f2; rm -f /tmp/f2"
}
out=$(remote)
check "ssh and scp to the new host print nothing" test -z "$out"
in_ct 'mv /var/www/blot /var/www/blot.away'
out=$(remote)
check "nor do they without /var/www/blot" test -z "$out"
in_ct 'mv /var/www/blot.away /var/www/blot'

echo "# A permanent ban survives a fail2ban restart"
# Real fail2ban with the deployed config. Ranges are RFC 5737 and RFC 3849.
f2b_start() { in_ct 'fail2ban-client -x start > /dev/null 2>&1; for i in $(seq 30); do fail2ban-client ping > /dev/null 2>&1 && exit 0; sleep 1; done; exit 1'; }
check "bantime.increment is off for manual-permaban and on elsewhere" in_ct '
  d=$(fail2ban-client -d 2> /dev/null)
  echo "$d" | grep manual-permaban | grep bantime.increment | grep -q False || exit 1
  echo "$d" | grep sshd | grep bantime.increment | grep -q True'
check "fail2ban starts" f2b_start
in_ct 'fail2ban-client set manual-permaban banip 192.0.2.0/24 > /dev/null && fail2ban-client set manual-permaban banip 2001:db8::/32 > /dev/null'
check "the bans are listed" in_ct 'fail2ban-client get manual-permaban banned | grep -F 192.0.2.0/24 | grep -qF 2001:db8::/32'
in_ct 'fail2ban-client stop > /dev/null 2>&1; sleep 1'
check "fail2ban starts again" f2b_start
# ping answers before the jail has restored its bans, so give it time, and show
# why on failure: a real miss must not look like this wait being too short.
check "both bans are still listed after the restart" in_ct '
  for i in $(seq 20); do
    fail2ban-client get manual-permaban banned | grep -F 192.0.2.0/24 | grep -qF 2001:db8::/32 && exit 0
    sleep 1
  done
  fail2ban-client status manual-permaban
  command -v sqlite3 > /dev/null && sqlite3 /var/lib/fail2ban/fail2ban.sqlite3 "select jail,ip,bantime from bips where jail=\"manual-permaban\""
  tail -30 /var/log/fail2ban.log
  exit 1'
check "and are still permanent in the database" in_ct '! command -v sqlite3 > /dev/null || [ "$(sqlite3 /var/lib/fail2ban/fail2ban.sqlite3 "select count(*) from bips where jail=\"manual-permaban\" and bantime=-1")" = 2 ]'
in_ct 'fail2ban-client stop > /dev/null 2>&1; rm -f /var/lib/fail2ban/fail2ban.sqlite3'

echo "# Re-running on a live host: instance store mounted, files in place"
in_ct 'rm /tmp/systemctl.log; chown 1234:1234 /var/instance-ssd/logs /var/instance-ssd/logs/access.log'
check "deploy.sh runs again" deploy "$TMP/run2"
check "the instance store unit is not started when mounted" in_ct '! grep -q "start mount-instance-store" /tmp/systemctl.log'
check "rsyslog is not restarted when its config is unchanged" in_ct '! grep -q "restart rsyslog" /tmp/systemctl.log && [ -S /run/blot-log/app.sock ]'
# A changed rsyslog config, with the deploy lock left by a unit deploy run as
# another user (the deploy user from GitHub)
in_ct 'rm -f /tmp/blot-proxy-deploy.lock; runuser -u ec2-user -- touch /tmp/blot-proxy-deploy.lock; echo "# older" >> /etc/rsyslog.d/blot-app-log.conf; rm /tmp/systemctl.log'
check "deploy.sh restarts rsyslog for a changed config, with another user's deploy lock" deploy "$TMP/run2c"
check "and did restart it, with the new config in place" in_ct 'grep -qx "restart rsyslog" /tmp/systemctl.log && ! grep -q "# older" /etc/rsyslog.d/blot-app-log.conf && [ -S /run/blot-log/app.sock ]'
in_ct '(sleep 3; exit 0) & flock /tmp/blot-proxy-deploy.lock sleep 4 & sleep 1; echo "# older" >> /etc/rsyslog.d/blot-app-log.conf; rm /tmp/systemctl.log'
check "and waits for a unit deploy holding the lock" deploy "$TMP/run2d"
check "before restarting" in_ct 'grep -qx "restart rsyslog" /tmp/systemctl.log'
in_ct 'chown root:root /var/instance-ssd/logs/app.log; chmod 600 /var/instance-ssd/logs/app.log'
check "deploy.sh runs over an app.log rsyslog made root's" deploy "$TMP/run3"
check "and gives it to ec2-user" in_ct '[ "$(stat -c %U:%G /var/instance-ssd/logs/app.log)" = ec2-user:ec2-user ] && runuser -u ec2-user -- head -c 1 /var/instance-ssd/logs/app.log > /dev/null'
check "the Redis backup unit is not started when /backups is mounted" in_ct '! grep -q "start blot-instance-store" /tmp/systemctl.log'
check "docker is never started, restarted or stopped" in_ct '! grep -E "(start|stop|restart).* docker" /tmp/systemctl.log'
check "the existing log directory and access log keep their owner" in_ct '
  [ "$(stat -c %u:%g /var/instance-ssd/logs)" = 1234:1234 ] && [ "$(stat -c %u:%g /var/instance-ssd/logs/access.log)" = 1234:1234 ]'
in_ct 'bash /home/ec2-user/scripts/mount-instance-store.sh > /dev/null'
check "mount-instance-store.sh does not take over an existing log directory" in_ct '[ "$(stat -c %u:%g /var/instance-ssd/logs)" = 1234:1234 ]'
check "mount-instance-store.sh does not take over an existing access log" in_ct '[ "$(stat -c %u:%g /var/instance-ssd/logs/access.log)" = 1234:1234 ]'
in_ct 'rm /var/instance-ssd/logs/access.log; bash /home/ec2-user/scripts/mount-instance-store.sh > /dev/null'
check "a wiped access log is recreated, so fail2ban can start" in_ct '[ "$(stat -c %u:%g /var/instance-ssd/logs/access.log)" = 1000:1000 ] && fail2ban-client -t > /dev/null 2>&1'
check "fail2ban is ordered after the instance store" in_ct 'grep -qx "After=mount-instance-store.service" /etc/systemd/system/fail2ban.service.d/10-instance-store.conf'
check "fail2ban's log is rotated" in_ct 'logrotate --debug /etc/logrotate.d/fail2ban 2>&1 | grep -q "/var/log/fail2ban.log"'
check "nothing was mounted a second time" in_ct '[ "$(grep -cx /var/instance-ssd /tmp/mounted)" = 1 ] && [ "$(grep -cx /backups /tmp/mounted)" = 1 ]'
check "sshd -T still reports x11forwarding no" in_ct 'sshd -T | grep -qx "x11forwarding no"'

echo "# A host without blot-instance-store.service (the Amazon Linux 2 app host)"
in_ct 'rm /etc/systemd/system/blot-instance-store.service /tmp/systemctl.log; sed -i "/^\/backups\$/d" /tmp/mounted'
check "deploy.sh runs, and starts nothing for Redis" deploy "$TMP/run2b"
check "the Redis backup unit is not started" in_ct '! grep -q "blot-instance-store" /tmp/systemctl.log'

echo "# The data volume is gone"
check "deploy.sh installs no data volume unit or docker drop-in" in_ct '
  [ ! -e /etc/systemd/system/mount-data-volume.service ] && [ ! -e /etc/systemd/system/docker.service.d/20-data-volume.conf ] &&
  [ ! -e /etc/blot/data-volume ] && ! grep -q mount-data-volume /tmp/systemctl.log'

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
