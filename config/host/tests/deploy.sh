#!/bin/bash
# Runs config/host/deploy.sh against an Amazon Linux 2023 container where
# host/setup.sh has run, the way a new host is built. ssh and scp are stubs that
# reach the container; the container has no systemd, so systemctl, mountpoint,
# mount, nvme and blkid are stubs too (systemctl start mount-instance-store runs
# the real mount-instance-store.sh against them). Everything else is real: sshd,
# fail2ban, logrotate, install, sed. host/setup.sh sets up Redis too, so this is
# a combined host: blot-instance-store.service (Redis's /backups) is started by
# deploy.sh once the instance store is mounted.
#
# Needs docker. Usage: config/host/tests/deploy.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
NAME=blot-host-deploy-test
VOLUME=vol-0123456789abcdef0
OTHER_VOLUME=vol-0fedcba987654321f
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
chmod +x sudo systemctl mountpoint mount nvme blkid'

echo "# A new host: no instance store mounted, no data volume file"
# Skip mode writes no units; the real one exists on a host set up with systemd.
in_ct 'touch /etc/systemd/system/blot-instance-store.service'
check "deploy.sh runs to the end" deploy "$TMP/run1" DATA_VOLUME_ID=$VOLUME
check "deploy.sh says so" grep -q '^Host setup complete' "$TMP/run1"
check "DATA_VOLUME_ID is written" in_ct "[ \"\$(cat /etc/blot/data-volume)\" = $VOLUME ]"
check "no marker is written for a volume that is not mounted" in_ct '[ ! -e /var/www/blot/data/.blot-data-volume ]'
check "mount-data-volume is enabled and started" in_ct 'grep -qx "enable --now mount-data-volume.service" /tmp/systemctl.log'
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

echo "# Re-running on a live host: instance store mounted, files in place"
in_ct 'rm /tmp/systemctl.log; chown 1234:1234 /var/instance-ssd/logs /var/instance-ssd/logs/access.log'
check "deploy.sh runs again, with another DATA_VOLUME_ID" deploy "$TMP/run2" DATA_VOLUME_ID=$OTHER_VOLUME
check "the existing data volume file is not overwritten" in_ct "[ \"\$(cat /etc/blot/data-volume)\" = $VOLUME ]"
check "the instance store unit is not started when mounted" in_ct '! grep -q "start mount-instance-store" /tmp/systemctl.log'
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
check "deploy.sh runs, and starts nothing for Redis" deploy "$TMP/run2b" DATA_VOLUME_ID=$VOLUME
check "the Redis backup unit is not started" in_ct '! grep -q "blot-instance-store" /tmp/systemctl.log'

echo "# DATA_VOLUME_ID and a data volume that is already mounted"
# A fake mounted volume: findmnt names a device, and the by-id link for $VOLUME
# points at it (or at nothing, for the volume that is not mounted).
in_ct 'rm /etc/blot/data-volume; echo /var/www/blot/data >> /tmp/mounted
mkdir -p /dev/disk/by-id; touch /tmp/fakedev
ln -s /tmp/fakedev /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0
printf "#!/bin/bash\necho /tmp/fakedev\n" > /usr/local/bin/findmnt; chmod +x /usr/local/bin/findmnt'
check "a different DATA_VOLUME_ID than the mounted volume is refused" bash -c "! env PATH='$TMP/bin:$PATH' SSH_KEY=unused PUBLIC_IP=host SSH_PORT=2222 DATA_VOLUME_ID=$OTHER_VOLUME bash '$REPO/config/host/deploy.sh' > '$TMP/run3' 2>&1"
check "and nothing was written" in_ct '[ ! -e /etc/blot/data-volume ] && [ ! -e /var/www/blot/data/.blot-data-volume ]'
check "the mounted volume's own ID is accepted" deploy "$TMP/run4" DATA_VOLUME_ID=$VOLUME
check "and written with its marker" in_ct "[ \"\$(cat /etc/blot/data-volume)\" = $VOLUME ] && [ \"\$(cat /var/www/blot/data/.blot-data-volume)\" = $VOLUME ]"
in_ct 'rm /etc/blot/data-volume /var/www/blot/data/.blot-data-volume'
check "without DATA_VOLUME_ID the mounted volume is still adopted" deploy "$TMP/run5"
check "and written with its marker" in_ct "[ \"\$(cat /etc/blot/data-volume)\" = $VOLUME ] && [ \"\$(cat /var/www/blot/data/.blot-data-volume)\" = $VOLUME ]"

echo "# Bad input"
check "a malformed DATA_VOLUME_ID is refused before anything runs" bash -c "! env PATH='$TMP/bin:$PATH' SSH_KEY=unused PUBLIC_IP=host DATA_VOLUME_ID='vol-xyz; rm' bash '$REPO/config/host/deploy.sh' > '$TMP/run6' 2>&1 && grep -q 'DATA_VOLUME_ID must look like' '$TMP/run6'"

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
