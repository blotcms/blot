#!/bin/bash
# Root-side setup of a new app host on Amazon Linux 2023 (arm64). bootstrap.sh
# copies this directory and setup-deploy-user.sh to the host and runs it with
# sudo. Idempotent and safe on a live host: it never starts or restarts docker
# and never upgrades an installed package. It also runs the Redis host setup
# (config/redis/host/setup.sh), after the firewall that keeps port 6379 private.
# What deploy.sh installs afterwards (scripts, units, fail2ban config) is not
# done here; see ../README.md.
#
# Env: REDIS_MAXMEMORY        required, Redis's maxmemory (e.g. 10gb). No default:
#                             the Redis setup's 70% of RAM is wrong on a host the
#                             units share
#      BLOT_SSH_PORT          optional, the port sshd listens on
#      BLOT_DEPLOY_PUBLIC_KEY optional, the deploy user's ssh public key
#      BLOT_VPC_CIDR, BLOT_MAIN_INTERFACE  optional, for tests: otherwise read
#                             from the instance metadata and `ip`
#      BLOT_HOST_SKIP_SYSTEMD=1  for container tests: no systemctl, sysctl or
#                                cgroup check, and Redis is started by hand
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKIP_SYSTEMD=${BLOT_HOST_SKIP_SYSTEMD:-}
APP_USER=ec2-user

# bootstrap.sh puts the deploy-user script and the Redis files next to this
# directory; in a checkout they are under scripts/deploy and config/redis.
DEPLOY_USER_SCRIPT=$(dirname "$HERE")/setup-deploy-user.sh
[ -f "$DEPLOY_USER_SCRIPT" ] || DEPLOY_USER_SCRIPT=$(dirname "$HERE")/../../scripts/deploy/setup-deploy-user.sh
REDIS_SETUP=$(dirname "$HERE")/redis/host/setup.sh
[ -f "$REDIS_SETUP" ] || REDIS_SETUP=$(dirname "$HERE")/../redis/host/setup.sh

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
# Required on a re-run too: the Redis setup protects a running Redis, so passing
# the value again is safe.
if [ -z "${REDIS_MAXMEMORY:-}" ]; then
  echo "REDIS_MAXMEMORY is required (e.g. 10gb)" >&2
  exit 1
fi
if ! [[ ${REDIS_MAXMEMORY,,} =~ ^[0-9]+([kmg]b?)?$ ]]; then
  echo "REDIS_MAXMEMORY must be a number of bytes, or a number with a kb, mb or gb suffix" >&2
  exit 1
fi

# The firewall rule for port 6379 names the VPC's range and the main network
# interface. Worked out here, before anything is installed. IMDSv2; BLOT_VPC_CIDR
# and BLOT_MAIN_INTERFACE are for tests, where there is no metadata service.
VPC_CIDR=${BLOT_VPC_CIDR:-}
MAIN_INTERFACE=${BLOT_MAIN_INTERFACE:-}
if [ -z "$VPC_CIDR" ] || [ -z "$MAIN_INTERFACE" ]; then
  imds() { curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
  IMDS_TOKEN=$(curl -fsS --max-time 5 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token) || IMDS_TOKEN=
  MAC=$([ -z "$IMDS_TOKEN" ] || imds mac) || MAC=
  if [ -z "$VPC_CIDR" ]; then
    VPC_CIDR=$([ -z "$MAC" ] || imds "network/interfaces/macs/$MAC/vpc-ipv4-cidr-block") || VPC_CIDR=
  fi
  if [ -z "$MAIN_INTERFACE" ] && [ -n "$MAC" ]; then
    MAIN_INTERFACE=$(ip -o link show | awk -v mac="$MAC" 'index(tolower($0), "link/ether " tolower(mac) " ") { sub(/:$/, "", $2); print $2; exit }') || MAIN_INTERFACE=
  fi
fi
if ! [[ $VPC_CIDR =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
  echo "Could not determine the VPC CIDR (got '${VPC_CIDR}'); set BLOT_VPC_CIDR" >&2
  exit 1
fi
if ! [[ $MAIN_INTERFACE =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then
  echo "Could not determine the main network interface (got '${MAIN_INTERFACE}'); set BLOT_MAIN_INTERFACE" >&2
  exit 1
fi

say "Packages"
# Only missing packages are installed, so nothing already on the host is
# upgraded. fail2ban-server, not the fail2ban metapackage, which pulls in
# firewalld and sendmail. rsyslog provides /var/log/secure, which the sshd jail
# in fail2ban/jail.local reads (the AL2 host has it too). iptables-nft is for
# the jails' iptables-multiport banaction. nftables is for the port 6379 rule
# below; its nftables.service is never enabled, because the default config
# flushes the whole ruleset, fail2ban's and docker's included.
PACKAGES="docker fail2ban-server iptables-nft nftables rsyslog cronie chrony rsync xfsprogs nvme-cli redis6 logrotate lsof"
missing=""
for pkg in $PACKAGES; do rpm -q "$pkg" > /dev/null 2>&1 || missing="$missing $pkg"; done
# shellcheck disable=SC2086
[ -z "$missing" ] || dnf install -y $missing

# The redis6 package only ships redis6-cli, and the proxy deploy scripts
# (common.sh, try-issuance.sh) refuse to run without redis-cli.
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

say "Firewall for Redis"
# redis.conf has bind 0.0.0.0, protected-mode no and no password, and replication
# needs TCP, so only loopback and the VPC may reach port 6379. EC2 delivers
# traffic for the public address to the private one, so `bind` cannot help: the
# rule matches on source. Docker bridges are dropped too, on purpose: the
# airlocks are untrusted. Units on --network host arrive over lo.
# The file replaces only its own table, in one transaction (the first line
# creates it if missing, so the delete never fails), so a re-run leaves no gap.
# Never `flush ruleset`: fail2ban and docker keep rules in the same nftables.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/blot-redis.nft" <<EOF2
# Installed by config/host/host/setup.sh. Loaded by blot-redis-firewall.service.
table inet blot_redis
delete table inet blot_redis
table inet blot_redis {
  chain input {
    # Before the default filter priority (0).
    type filter hook input priority -10; policy accept;
    iifname "lo" accept
    iifname "$MAIN_INTERFACE" ip saddr $VPC_CIDR tcp dport 6379 accept
    tcp dport 6379 drop
  }
}
EOF2
if ! nft -c -f "$TMP/blot-redis.nft" 2> "$TMP/nft-check"; then
  # A container without NET_ADMIN cannot check; a real host must.
  if [ -n "$SKIP_SYSTEMD" ] && grep -q 'Operation not permitted' "$TMP/nft-check"; then
    echo "    WARNING: no permission to check the nft file here"
  else
    cat "$TMP/nft-check" >&2
    echo "nft rejected the Redis firewall file" >&2
    exit 1
  fi
fi
put /etc/nftables/blot-redis.nft 0644 root:root < "$TMP/blot-redis.nft"
FIREWALL_CHANGED=$CHANGED
# Not nftables.service. Reloaded, never restarted, because redis6 Requires= this
# unit (below) and a restart would restart Redis with it.
put /etc/systemd/system/blot-redis-firewall.service 0644 root:root <<'EOF2'
[Unit]
Description=Firewall for Redis (port 6379 from loopback and the VPC only)
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target redis6.service shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables/blot-redis.nft
ExecReload=/usr/sbin/nft -f /etc/nftables/blot-redis.nft

[Install]
WantedBy=multi-user.target
EOF2
# Requires=, so Redis does not start if the rules failed to load: the one place
# fail-closed is wanted, unlike the Wants= in zz-blot.conf.
put /etc/systemd/system/redis6.service.d/zz-blot-firewall.conf 0644 root:root <<'EOF2'
[Unit]
Requires=blot-redis-firewall.service
After=blot-redis-firewall.service
EOF2
if [ -z "$SKIP_SYSTEMD" ]; then
  systemctl daemon-reload
  systemctl enable blot-redis-firewall.service
  if systemctl is-active --quiet blot-redis-firewall.service; then
    [ "$FIREWALL_CHANGED" = 0 ] || systemctl reload blot-redis-firewall.service
  else
    systemctl start blot-redis-firewall.service
  fi
fi

say "Redis host setup"
# On a live host a running Redis is not restarted (see its setup.sh).
env BLOT_REDIS_SHARED_INSTANCE_STORE=1 REDIS_MAXMEMORY="$REDIS_MAXMEMORY" \
  BLOT_REDIS_SKIP_SYSTEMD="$SKIP_SYSTEMD" bash "$REDIS_SETUP"

say "Verification"
[ -n "$SKIP_SYSTEMD" ] || echo "docker: $(systemctl is-enabled docker) ($(systemctl is-active docker || true))"
echo "redis-cli -> $(readlink -f "$(command -v redis-cli)")"
echo "net.ipv4.tcp_migrate_req = $(sysctl -n net.ipv4.tcp_migrate_req 2> /dev/null || echo n/a)"
echo "sshd port: ${BLOT_SSH_PORT:-unchanged}"
echo "port 6379: loopback and $VPC_CIDR on $MAIN_INTERFACE only"
echo "deploy: $(id -nG deploy)"
[ ! -d /var/www/blot ] || ls -ld /var/www/blot /var/www/blot/data /var/www/blot/app/blog/static
