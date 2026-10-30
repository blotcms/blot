#!/bin/bash
# Runs config/host/host/setup.sh in Amazon Linux 2023 containers: with
# BLOT_HOST_SKIP_SYSTEMD=1 (the base image has no systemd), twice, then checks
# that the second run changed nothing and the result is what setup.sh promises.
# Also runs it in a real Amazon Linux 2 image, where it must refuse.
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
setup() { # setup <output file>
  docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 -e BLOT_SSH_PORT=2222 -e "BLOT_DEPLOY_PUBLIC_KEY=$KEY" \
    "$NAME" bash /repo/config/host/host/setup.sh > "$1" 2>&1 ||
    { cat "$1"; fail "setup.sh exited non-zero"; return 1; }
}

# Files setup.sh manages, in one checksum.
sums() {
  in_ct 'sha256sum /etc/cron.d/blot-docker-health /etc/systemd/system/docker.service.d/30-redis.conf \
    /etc/ssh/sshd_config.d/11-blot-port.conf /etc/sysctl.d/91-blot-host.conf /etc/ssh/sshd_config \
    /home/deploy/.ssh/authorized_keys /etc/rsyslog.d/30-deploy-user.conf /etc/logrotate.d/deploy-user
    stat -c "%n %U:%G %a" /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static
    readlink /usr/local/bin/redis-cli; id -nG ec2-user deploy'
}

TMP=$(mktemp -d)
trap 'cleanup; rm -rf "$TMP"' EXIT

echo "# Amazon Linux 2023"
docker run -d --name "$NAME" -v "$REPO:/repo:ro" amazonlinux:2023 sleep 3600 > /dev/null
# Test artifacts: the base image lacks these, a real AMI has them.
docker exec "$NAME" dnf install -y -q shadow-utils diffutils openssh-server > /dev/null
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
check "sshd -t passes with the port drop-in" in_ct 'sshd -t && sshd -T | grep -qx "port 2222"'
check "the port drop-in is separate from 10-blot.conf" in_ct '[ ! -e /etc/ssh/sshd_config.d/10-blot.conf ]'

echo "# bootstrap.sh"
# A stub ssh and sudo, so the real tar pipe and quoting reach the container.
mkdir "$TMP/bin"
cat > "$TMP/bin/ssh" <<EOF
#!/bin/bash
while [ "\$1" = -o ]; do shift 2; done
shift
exec docker exec -i -e BLOT_HOST_SKIP_SYSTEMD=1 $NAME bash -c "\$*"
EOF
chmod +x "$TMP/bin/ssh"
in_ct 'dnf install -y -q tar > /dev/null && printf "#!/bin/bash\nexec \"\$@\"\n" > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo'
check "bootstrap.sh copies the files and runs setup.sh" \
  env PATH="$TMP/bin:$PATH" BLOT_SSH_PORT=2222 BLOT_DEPLOY_PUBLIC_KEY="$KEY" \
  bash -c "'$REPO/config/host/bootstrap.sh' host > '$TMP/bootstrap' 2>&1"
check "the deploy-user script is found in the copied layout" in_ct '[ -f /tmp/blot-host/setup-deploy-user.sh ] && [ -f /tmp/blot-host/host/setup.sh ]'
check "the key survives the remote shell's quoting" in_ct "[ \"\$(grep -c 'test@example.com' /home/deploy/.ssh/authorized_keys)\" = 1 ]"

echo "# Amazon Linux 2023 without the optional env"
cleanup
docker run -d --name "$NAME" -v "$REPO:/repo:ro" amazonlinux:2023 sleep 3600 > /dev/null
docker exec "$NAME" dnf install -y -q shadow-utils diffutils > /dev/null
check "runs without ec2-user, a key or a port" \
  docker exec -e BLOT_HOST_SKIP_SYSTEMD=1 "$NAME" bash /repo/config/host/host/setup.sh > "$TMP/bare" 2>&1
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
