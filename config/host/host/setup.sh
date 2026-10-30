#!/bin/bash
# Root-side setup of a new app host on Amazon Linux 2023 (arm64). bootstrap.sh
# copies this directory and setup-deploy-user.sh to the host and runs it with
# sudo. Idempotent and safe on a live host: it never starts or restarts docker
# and never upgrades an installed package. What deploy.sh installs afterwards
# (scripts, units, fail2ban config) is not done here; see ../README.md.
#
# Env: BLOT_SSH_PORT          optional, the port sshd listens on
#      BLOT_DEPLOY_PUBLIC_KEY optional, the deploy user's ssh public key
#      BLOT_HOST_SKIP_SYSTEMD=1  for container tests: no systemctl, sysctl or
#                                cgroup check
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKIP_SYSTEMD=${BLOT_HOST_SKIP_SYSTEMD:-}
APP_USER=ec2-user

# bootstrap.sh puts the deploy-user script next to this directory; in a
# checkout it is under scripts/deploy.
DEPLOY_USER_SCRIPT=$(dirname "$HERE")/setup-deploy-user.sh
[ -f "$DEPLOY_USER_SCRIPT" ] || DEPLOY_USER_SCRIPT=$(dirname "$HERE")/../../scripts/deploy/setup-deploy-user.sh

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }
sd() { [ -n "$SKIP_SYSTEMD" ] || systemctl "$@"; }

# put <path> <mode> <owner:group>: install stdin at <path> if it differs.
# Sets CHANGED to 1 if the file was written.
put() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  CHANGED=0
  if ! cmp -s "$tmp" "$1"; then
    install -D -m "$2" -o "${3%%:*}" -g "${3##*:}" "$tmp" "$1"
    echo "    updated $1"
    CHANGED=1
  fi
  rm -f "$tmp"
}

say "Checking the OS"
# The production host is still Amazon Linux 2; this must not run there.
VERSION_ID=
# shellcheck disable=SC1091
. /etc/os-release
if [ "$VERSION_ID" != 2023 ]; then
  echo "This sets up an Amazon Linux 2023 host, but this is ${PRETTY_NAME:-an unknown OS}." >&2
  exit 1
fi
if [ -z "$SKIP_SYSTEMD" ] && [ "$(stat -fc %T /sys/fs/cgroup)" != cgroup2fs ]; then
  echo "cgroup v2 is not mounted; the units' memory accounting expects it" >&2
  exit 1
fi
if [ -n "${BLOT_SSH_PORT:-}" ] && ! [[ $BLOT_SSH_PORT =~ ^[0-9]+$ ]]; then
  echo "BLOT_SSH_PORT must be a number" >&2
  exit 1
fi

say "Packages"
# Only missing packages are installed, so nothing already on the host is
# upgraded. fail2ban-server, not the fail2ban metapackage, which pulls in
# firewalld and sendmail. rsyslog provides /var/log/secure, which the sshd jail
# in fail2ban/jail.local reads (the AL2 host has it too). iptables-nft is for
# the jails' iptables-multiport banaction.
PACKAGES="docker fail2ban-server iptables-nft rsyslog cronie chrony rsync xfsprogs nvme-cli redis6 logrotate lsof"
missing=""
for pkg in $PACKAGES; do rpm -q "$pkg" > /dev/null 2>&1 || missing="$missing $pkg"; done
# shellcheck disable=SC2086
[ -z "$missing" ] || dnf install -y $missing

# The redis6 package only ships redis6-cli, and the proxy deploy scripts
# (common.sh, try-issuance.sh) refuse to run without redis-cli. This does not
# set up Redis itself.
ln -sfn /usr/bin/redis6-cli /usr/local/bin/redis-cli

say "Docker"
# Enabled, not started: deploy.sh's drop-ins gate docker on the instance store
# and the data volume, and on a fresh host the data volume arrives later.
sd enable docker
put /etc/systemd/system/docker.service.d/30-redis.conf 0644 root:root <<'EOF2'
[Unit]
# Units must not boot into Redis still LOADING. Neither Wants= nor Requires=:
# a stop or restart of redis6 must not take docker, and every container, with it.
After=redis6.service
EOF2
[ -n "$SKIP_SYSTEMD" ] || [ "$CHANGED" = 0 ] || systemctl daemon-reload
if id "$APP_USER" > /dev/null 2>&1; then
  id -nG "$APP_USER" | grep -qw docker || usermod -aG docker "$APP_USER"
else
  echo "    WARNING: user $APP_USER does not exist; it was not added to the docker group"
fi

say "Deploy user"
# With a key the script rewrites authorized_keys only if the key is missing;
# without one it leaves an existing file alone.
if [ -n "${BLOT_DEPLOY_PUBLIC_KEY:-}" ]; then
  bash "$DEPLOY_USER_SCRIPT" "$BLOT_DEPLOY_PUBLIC_KEY"
else
  bash "$DEPLOY_USER_SCRIPT"
fi

say "SSH"
# Not 10-blot.conf, which config/redis/host/setup.sh owns and overwrites.
if [ -n "${BLOT_SSH_PORT:-}" ]; then
  put /etc/ssh/sshd_config.d/11-blot-port.conf 0600 root:root <<EOF2
# Installed by config/host/host/setup.sh.
Port $BLOT_SSH_PORT
EOF2
fi
# Always reloaded: setup-deploy-user.sh adds a Match block to sshd_config too.
# Reloaded, not restarted, so a live session survives; and only if `sshd -t`
# accepts the result, so a bad config never stops sshd.
if ! ls /etc/ssh/ssh_host_*_key > /dev/null 2>&1 && [ -n "$SKIP_SYSTEMD" ]; then
  echo "    no host keys: sshd -t not run"
elif sshd -t; then
  sd reload sshd
else
  rm -f /etc/ssh/sshd_config.d/11-blot-port.conf
  echo "    WARNING: sshd -t rejected the config; removed 11-blot-port.conf, so sshd keeps its old port"
fi

say "Cron"
# deploy.sh installs the script itself.
put /etc/cron.d/blot-docker-health 0644 root:root <<'EOF2'
# Installed by config/host/host/setup.sh
* * * * * root /usr/local/bin/check_docker_health.sh >/dev/null 2>&1
EOF2

say "Services"
sd enable --now crond rsyslog chronyd
# Not started: deploy.sh installs its config and starts it.
sd enable fail2ban

say "Directories"
# /var/www/blot/data is where the data volume is mounted later, and
# /var/www/blot/app/blog/static is bind-mounted read-only into the units.
# Existing directories are left alone.
owner=root
if id "$APP_USER" > /dev/null 2>&1; then
  owner=$APP_USER
else
  echo "    WARNING: user $APP_USER does not exist; creating the directories as root"
fi
for dir in /var/www/blot /var/www/blot/data /var/www/blot/app /var/www/blot/app/blog /var/www/blot/app/blog/static; do
  [ -d "$dir" ] || { install -d -m 0755 -o "$owner" -g "$owner" "$dir"; echo "    created $dir"; }
done

say "Kernel settings"
put /etc/sysctl.d/91-blot-host.conf 0644 root:root <<'EOF2'
# App host settings (config/host/host/setup.sh).
# Move queued connections to another listener in the reuseport group when a
# unit's listener closes, instead of resetting them (see TODO).
net.ipv4.tcp_migrate_req = 1
EOF2
[ -n "$SKIP_SYSTEMD" ] || sysctl -q -p /etc/sysctl.d/91-blot-host.conf

say "Verification"
[ -n "$SKIP_SYSTEMD" ] || echo "docker: $(systemctl is-enabled docker) ($(systemctl is-active docker || true))"
echo "redis-cli -> $(readlink -f "$(command -v redis-cli)")"
echo "net.ipv4.tcp_migrate_req = $(sysctl -n net.ipv4.tcp_migrate_req 2> /dev/null || echo n/a)"
echo "sshd port: ${BLOT_SSH_PORT:-unchanged}"
echo "deploy: $(id -nG deploy)"
[ ! -d /var/www/blot ] || ls -ld /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static
