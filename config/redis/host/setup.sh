#!/bin/bash
# Root-side Redis host setup. bootstrap.sh copies this directory to the host
# and runs it with sudo. Idempotent, and safe on a live host: a running Redis
# is never restarted. Its settings are changed with CONFIG SET where Redis
# allows it, and the rest is listed as needing a restart.
#
# Env: REDIS_MAXMEMORY       maxmemory value (default: 70% of RAM)
#      BLOT_REDIS_SKIP_SYSTEMD=1  for container tests: no systemd, sysctl or
#                                 package extras, and Redis is started by hand
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
SKIP_SYSTEMD=${BLOT_REDIS_SKIP_SYSTEMD:-}
BACKUP_USER=ec2-user

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }
sd() { [ -n "$SKIP_SYSTEMD" ] || systemctl "$@"; }
redis_up() { redis6-cli INFO server > /dev/null 2>&1; }

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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Packages"
# Only missing packages are installed, so a running Redis is never upgraded.
PACKAGES="redis6 nvme-cli xfsprogs cronie awscli-2 rsync"
[ -z "$SKIP_SYSTEMD" ] || PACKAGES=redis6
missing=""
for pkg in $PACKAGES; do rpm -q "$pkg" > /dev/null 2>&1 || missing="$missing $pkg"; done
# shellcheck disable=SC2086
[ -z "$missing" ] || dnf install -y $missing

say "Checking the new config"
# maxmemory depends on the host, so it lives in its own small included file.
MAXMEMORY=${REDIS_MAXMEMORY:-$(awk '/^MemTotal:/ {printf "%d", $2 * 1024 * 0.7}' /proc/meminfo)}
printf '# Written by host/setup.sh: about 70%% of RAM (REDIS_MAXMEMORY overrides it).\nmaxmemory %s\n' \
  "$MAXMEMORY" > "$TMP/blot-memory.conf"

# Start a throwaway Redis on a unix socket with the new config. It proves the
# config parses before anything is installed, and gives us Redis's own
# normalised view of every setting to compare against a running server.
# (logfile is dropped: Redis opens the file while parsing, as root here.)
{ grep -vE '^(include|logfile|pidfile|dir) ' "$ROOT/redis.conf"; cat "$TMP/blot-memory.conf"; } > "$TMP/test.conf"
redis6-server "$TMP/test.conf" --dir "$TMP" --logfile "$TMP/log" --pidfile "$TMP/pid" \
  --port 0 --unixsocket "$TMP/sock" --daemonize yes --supervised no ||
  { cat "$TMP/log" 2> /dev/null || true; echo "redis6-server rejected redis.conf" >&2; exit 1; }
scratch() { redis6-cli -s "$TMP/sock" "$@"; }
for _ in $(seq 1 20); do scratch PING 2> /dev/null | grep -q PONG && break; sleep 0.5; done
scratch PING | grep -q PONG || { cat "$TMP/log"; echo "scratch Redis did not start" >&2; exit 1; }
echo "    redis.conf parses"

# Settings to compare with the running server. Skip ones the scratch server
# overrides or that cannot meaningfully differ.
SETTINGS=$(awk '!/^[ \t]*(#|$)/ {print tolower($1)}' "$TMP/test.conf" | sort -u |
  grep -vxE 'bind|port|dir|logfile|pidfile')
for s in $SETTINGS; do printf '%s\t%s\n' "$s" "$(scratch CONFIG GET "$s" | sed -n 2p)"; done > "$TMP/wanted"
scratch SHUTDOWN NOSAVE > /dev/null 2>&1 || true

say "Config files"
put /etc/redis6/blot-memory.conf 0640 root:redis6 < "$TMP/blot-memory.conf"
# Keep the package's stock config (or the live host's old one) the first time.
[ -f /etc/redis6/redis6.conf.dist ] || cp -p /etc/redis6/redis6.conf /etc/redis6/redis6.conf.dist
put /etc/redis6/redis6.conf 0640 root:redis6 < "$ROOT/redis.conf"

say "Scripts"
install -m 0755 -o root -g root -t /usr/local/bin \
  "$ROOT"/bin/*.sh "$HERE/mount-instance-store.sh"
mkdir -p /etc/blot-redis # holds floating-ip, which marks the active host for backup.sh
# The backup user reads Redis's RDB through the redis6 group.
if id "$BACKUP_USER" > /dev/null 2>&1; then
  id -nG "$BACKUP_USER" | grep -qw redis6 || usermod -aG redis6 "$BACKUP_USER"
else
  echo "    WARNING: user $BACKUP_USER does not exist; backups and monitoring cron jobs will not run"
fi

put /etc/cron.d/blot-redis 0644 root:root <<EOF
# Installed by config/redis/host/setup.sh.
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
0 * * * * $BACKUP_USER /usr/local/bin/backup.sh hourly >> /home/$BACKUP_USER/backup.log 2>&1
5 3 * * * $BACKUP_USER /usr/local/bin/backup.sh daily >> /home/$BACKUP_USER/backup.log 2>&1
0 0 1 * * $BACKUP_USER : > /home/$BACKUP_USER/backup.log
*/5 * * * * $BACKUP_USER /usr/local/bin/tcpmem-log.sh
*/5 * * * * $BACKUP_USER /usr/local/bin/redis-mem-log.sh
EOF
if crontab -l -u "$BACKUP_USER" 2> /dev/null | grep -E 'backup\.sh|mem-log\.sh|stats\.sh'; then
  if [ -s /etc/blot-redis/floating-ip ]; then
    echo "    WARNING: the crontab entries above are now duplicated by /etc/cron.d/blot-redis; remove them"
  else
    # backup.sh skips until the host is marked active, so the old jobs are
    # still the only ones uploading.
    echo "    WARNING: keep the old backup entries above until /etc/blot-redis/floating-ip"
    echo "    is written (at cutover); until then the new backup job skips. The"
    echo "    mem-log/tcpmem entries are duplicated and can go now."
  fi
fi

put /etc/logrotate.d/blot-redis 0644 root:root <<'EOF'
# The package's logrotate file covers /var/log/redis, not /var/log/redis6.
/var/log/redis6/*.log {
    weekly
    rotate 8
    copytruncate
    compress
    delaycompress
    notifempty
    missingok
    su redis6 redis6
}
EOF

if [ -z "$SKIP_SYSTEMD" ]; then
  say "Kernel settings"
  put /etc/sysctl.d/90-blot-redis.conf 0644 root:root <<'EOF'
# Redis host settings (config/redis/host/setup.sh).
# Allow fork() for a background save even when memory looks tight.
vm.overcommit_memory = 1
# Swap is off; 1 keeps the kernel from reclaiming Redis's pages early.
vm.swappiness = 1
# Match tcp-backlog in redis.conf.
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
# tcp_mem is deliberately left at the kernel default.
EOF
  sysctl -q -p /etc/sysctl.d/90-blot-redis.conf
  # sysctl.d files apply in name order, so a later file would win at boot.
  grep -En '^[[:space:]]*(vm\.overcommit_memory|vm\.swappiness|net\.core\.somaxconn|net\.ipv4\.tcp_max_syn_backlog)' \
    /etc/sysctl.conf /etc/sysctl.d/*.conf 2> /dev/null | grep -v '^/etc/sysctl.d/90-blot-redis.conf' |
    sed 's/^/    WARNING: also set in /' || true

  say "Services"
  put /etc/systemd/system/blot-disable-thp.service 0644 root:root <<'EOF'
[Unit]
Description=Disable transparent huge pages (Redis latency)
Before=redis6.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'

[Install]
WantedBy=multi-user.target
EOF
  put /etc/systemd/system/blot-instance-store.service 0644 root:root <<'EOF'
[Unit]
Description=Mount the instance store at /backups
Before=redis6.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/mount-instance-store.sh

[Install]
WantedBy=multi-user.target
EOF
  # Named zz- so it sorts after the package's limit.conf (LimitNOFILE=10240),
  # which would otherwise win. Wants=, not Requires=: Redis starts even if the
  # mount or the THP setting fails.
  put /etc/systemd/system/redis6.service.d/zz-blot.conf 0644 root:root <<'EOF'
[Unit]
Wants=blot-instance-store.service blot-disable-thp.service
After=blot-instance-store.service blot-disable-thp.service

[Service]
LimitNOFILE=65536
Restart=always
# Loading or saving a multi-GB RDB outlasts systemd's 90s default.
TimeoutStartSec=600
TimeoutStopSec=300
EOF
  put /etc/systemd/journald.conf.d/blot.conf 0644 root:root <<'EOF'
[Journal]
SystemMaxUse=100M
EOF
  [ "$CHANGED" = 0 ] || systemctl restart systemd-journald
  systemctl daemon-reload
  systemctl enable --now blot-disable-thp.service
  systemctl enable --now blot-instance-store.service ||
    echo "    WARNING: /backups is not mounted; Redis will still start (see: journalctl -u blot-instance-store)"
  systemctl enable --now crond
fi

say "Redis"
if redis_up; then
  echo "    already running: not restarting it"
  sd enable redis6
  : > "$TMP/restart"
  while IFS=$'\t' read -r name want; do
    have=$(redis6-cli CONFIG GET "$name" | sed -n 2p)
    [ "$have" != "$want" ] || continue
    # Do not lower maxmemory below what is already in use (noeviction would
    # start refusing writes).
    if [ "$name" = maxmemory ] &&
      [ "$(redis6-cli INFO memory | tr -d '\r' | awk -F: '$1 == "used_memory" {print $2}')" -gt "$want" ]; then
      echo "$name: not applied, memory in use exceeds $want" >> "$TMP/restart"
    elif [ "$(redis6-cli CONFIG SET "$name" "$want")" = OK ]; then
      echo "    applied  $name: '$have' -> '$want'"
    else
      echo "$name: running '$have', file '$want'" >> "$TMP/restart"
    fi
  done < "$TMP/wanted"
  pid=$(redis6-cli INFO server | tr -d '\r' | awk -F: '$1 == "process_id" {print $2}')
  nofile=$(awk '/^Max open files/ {print $4}' "/proc/$pid/limits")
  if [ -z "$SKIP_SYSTEMD" ] && [ "$nofile" != 65536 ]; then
    echo "LimitNOFILE: running $nofile, unit 65536" >> "$TMP/restart"
  fi
  if [ -s "$TMP/restart" ]; then
    echo "    Need a restart (not done), differing from the new config:"
    sed 's/^/      /' "$TMP/restart"
  else
    echo "    running settings match the new config"
  fi
else
  if [ -n "$SKIP_SYSTEMD" ]; then
    runuser -u redis6 -- redis6-server /etc/redis6/redis6.conf --daemonize yes --supervised no
  else
    systemctl enable --now redis6
  fi
  for _ in $(seq 1 120); do redis6-cli PING 2> /dev/null | grep -q PONG && break; sleep 1; done
  redis6-cli PING | grep -q PONG || { echo "Redis did not answer PING" >&2; exit 1; }
  echo "    started"
fi

say "Verification"
redis6-cli INFO server | tr -d '\r' | grep -E '^(redis_version|config_file):'
for key in maxmemory save maxmemory-policy; do
  echo "$key: $(redis6-cli CONFIG GET "$key" | sed -n 2p)"
done
echo "THP: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
for key in vm.overcommit_memory vm.swappiness net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.tcp_mem; do
  echo "$key = $(sysctl -n "$key" 2> /dev/null || echo n/a)"
done
pid=$(redis6-cli INFO server | tr -d '\r' | awk -F: '$1 == "process_id" {print $2}')
echo "LimitNOFILE of Redis (pid $pid): $(awk '/^Max open files/ {print $4}' "/proc/$pid/limits")"
