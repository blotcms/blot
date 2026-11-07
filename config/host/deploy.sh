#!/bin/sh

# Host setup for the production proxy host: the certificate-cleanup and
# health-check scripts in ./scripts, systemd ordering, fail2ban, logrotate, sshd and
# .bashrc. The proxy itself is a container: deploy it with
# `npm run deploy-units` (scripts/deploy/units.sh). Run it with
# `npm run deploy-host`; see README.md in this directory.
#
# Everything here is found relative to this file, so it can be run from any
# directory. The install paths on the host (/home/ec2-user/scripts, /etc/...)
# are hardcoded elsewhere (systemd units, cron, proxy/deploy) and must not move.

# this exits the script if any command fails
set -e

if [ -z "$SSH_KEY" ]; then
  echo "SSH_KEY variable missing, pass the path to the key as an argument to this script"
  exit 1
fi

# ssh port of the proxy host, defaults to 22
SSH_PORT="${SSH_PORT:-22}"

if [ -z "$PUBLIC_IP" ]; then
  echo "PUBLIC_IP variable missing, pass the public ip address of the proxy host as an argument to this script"
  exit 1
fi

# Optional: extra options for every ssh and scp below, -o options only (scp's
# -p is not ssh's). cycle.sh passes its host key settings for a new host.
# env, not the command builtin: on a Mac this is bash 3.2 as sh, where a failing
# `command ssh` trips set -e even as the condition of an if.
if [ -n "${SSH_OPTS:-}" ]; then
  # shellcheck disable=SC2086
  ssh() { /usr/bin/env ssh $SSH_OPTS "$@"; }
  # shellcheck disable=SC2086
  scp() { /usr/bin/env scp $SSH_OPTS "$@"; }
fi

#upload the scripts to the proxy host
SCRIPTS_DIRECTORY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/scripts"
echo "Uploading $SCRIPTS_DIRECTORY to ~/scripts on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "rm -rf /home/ec2-user/scripts"
scp -P "$SSH_PORT" -i $SSH_KEY -r $SCRIPTS_DIRECTORY ec2-user@$PUBLIC_IP:/home/ec2-user/scripts
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "chmod +x /home/ec2-user/scripts/*"

# cron runs the health check from /usr/local/bin, not ~/scripts
echo "Installing check_docker_health.sh to /usr/local/bin on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo install -m 755 /home/ec2-user/scripts/check_docker_health.sh /usr/local/bin/check_docker_health.sh"

# cron runs the memory sampler from /usr/local/bin too. This is the first
# cron entry deploy.sh installs (check_docker_health.sh's is still by hand): an
# /etc/cron.d file is replaced whole each run, so there is nothing to duplicate.
# The log is in /var/instance-ssd/logs, which survives deploys; see README.md.
echo "Installing unit-mem-log.sh, unit-mem-summary.sh and /etc/cron.d/blot-unit-mem on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo install -m 755 /home/ec2-user/scripts/unit-mem-log.sh /home/ec2-user/scripts/unit-mem-summary.sh /usr/local/bin/"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "printf '%s\n' '# Installed by config/host/deploy.sh' '* * * * * root /usr/local/bin/unit-mem-log.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/blot-unit-mem >/dev/null && sudo chmod 644 /etc/cron.d/blot-unit-mem && sudo chown root:root /etc/cron.d/blot-unit-mem"

# Install (or update) the mount-instance-store unit and the docker.service.d
# drop-in that gates on it, so docker cannot (re)start at boot against the
# not-yet-mounted, empty /var/instance-ssd. daemon-reload alone is safe against
# a running unit, but nothing here may restart docker.service or
# mount-instance-store.service: all are live on a running host (restarting
# docker would kill the running containers, restarting the mount unit would
# unmount the cache under them). The unit is enabled, and started only if
# /var/instance-ssd is not already a mountpoint, which is the case on a new
# host (fail2ban below needs the log directory on it). On a running host the
# mount is there and nothing is started; the new docker ordering takes effect at
# the next reboot.
# 20-rsyslog.conf orders docker after rsyslog the same way, for the units'
# syslog log driver (see the rsyslog section below).
echo "Installing mount-instance-store.service and its docker.service.d drop-ins on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-instance-store.service /etc/systemd/system/mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/*.conf /etc/systemd/system/docker.service.d/"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl enable mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "mountpoint -q /var/instance-ssd || sudo systemctl start mount-instance-store.service"
echo "mount-instance-store / docker.service ordering installed."

# On a new combined host host/setup.sh ran before the instance store was
# mounted, so blot-instance-store.service (Redis's /backups, a bind mount of a
# directory of it) failed then. Start it now. Nothing happens where the unit
# does not exist (the Amazon Linux 2 app host) or /backups is already mounted.
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "if [ -e /etc/systemd/system/blot-instance-store.service ] && ! mountpoint -q /backups; then sudo systemctl start blot-instance-store.service || echo \"WARNING: /backups is not mounted; see journalctl -u blot-instance-store\"; fi"

# Remove the legacy mount-data-disk unit: its script was never part of this
# directory and no longer exists on the host, so the unit only fails at boot.
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "if [ -f /etc/systemd/system/mount-data-disk.service ]; then sudo systemctl disable mount-data-disk.service || true; sudo rm -f /etc/systemd/system/mount-data-disk.service; fi"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload && sudo systemctl reset-failed mount-data-disk.service 2>/dev/null || true"

#########################################################
# Begin Fail2Ban deployment section
#########################################################

FAIL2BAN_LOCAL_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/fail2ban"

# Upload filters
for filter in "$FAIL2BAN_LOCAL_DIR"/filter.d/*.conf; do
  filter_name=$(basename "$filter")
  echo "Uploading filter $filter_name to $PUBLIC_IP:/etc/fail2ban/filter.d/"
  scp -P "$SSH_PORT" -i "$SSH_KEY" "$filter" ec2-user@$PUBLIC_IP:/tmp/"$filter_name"
  ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/$filter_name /etc/fail2ban/filter.d/$filter_name && sudo chown root:root /etc/fail2ban/filter.d/$filter_name"
done

# Upload jail.local
echo "Uploading jail.local to $PUBLIC_IP:/etc/fail2ban/jail.local"
scp -P "$SSH_PORT" -i "$SSH_KEY" "$FAIL2BAN_LOCAL_DIR/jail.local" ec2-user@$PUBLIC_IP:/tmp/jail.local
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/jail.local /etc/fail2ban/jail.local && sudo chown root:root /etc/fail2ban/jail.local"

# Upload fail2ban.local
echo "Uploading fail2ban.local to $PUBLIC_IP:/etc/fail2ban/fail2ban.local"
scp -P "$SSH_PORT" -i "$SSH_KEY" "$FAIL2BAN_LOCAL_DIR/fail2ban.local" ec2-user@$PUBLIC_IP:/tmp/fail2ban.local
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/fail2ban.local /etc/fail2ban/fail2ban.local && sudo chown root:root /etc/fail2ban/fail2ban.local"

# A jail whose logpath does not exist stops fail2ban from starting at all. On
# a new host the access log does not exist until the proxy has started, so
# create what is missing, for every logpath in the jail.local just uploaded.
# Existing files are never touched. The access log is in the container's log
# directory, owned by uid 1000 (see mount-instance-store.sh); the directory
# itself must already be there, i.e. the instance store mounted.
echo "Making sure the log files in jail.local exist on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo bash -s" <<'LOGFILES'
set -eu
for logpath in $(sed -n 's/^[[:space:]]*logpath[[:space:]]*=[[:space:]]*//p' /etc/fail2ban/jail.local | sort -u); do
  [ ! -e "$logpath" ] || continue
  [ -d "$(dirname "$logpath")" ] || { echo "ERROR: $(dirname "$logpath") does not exist, so $logpath cannot be created."; exit 1; }
  case "$logpath" in
    /var/instance-ssd/logs/*) install -m 644 -o 1000 -g 1000 /dev/null "$logpath" ;;
    *) install -m 600 -o root -g root /dev/null "$logpath" ;;
  esac
  echo "Created $logpath."
done
LOGFILES

# Order fail2ban after the instance store, which holds a logpath, at boot.
echo "Installing the fail2ban.service.d drop-in on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/fail2ban.service.d && sudo cp /home/ec2-user/scripts/fail2ban.service.d/10-instance-store.conf /etc/systemd/system/fail2ban.service.d/10-instance-store.conf && sudo systemctl daemon-reload"

# Restart fail2ban
echo "Restarting fail2ban on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo systemctl restart fail2ban"

echo "Fail2Ban deployment complete."
#########################################################

#########################################################
# Begin sshd hardening section
#########################################################

# sshd uses the first value it reads. Amazon Linux 2 has no drop-in directory
# and the sed is enough. On Amazon Linux 2023 sshd_config includes
# sshd_config.d/*.conf at the top and 50-redhat.conf there sets
# `X11Forwarding yes`, so the sed has no effect and a drop-in that sorts before
# it is what counts. 12- sits after 10-blot.conf (config/redis/host/setup.sh)
# and 11-blot-port.conf (host/setup.sh). It is only written where sshd_config
# includes the directory, so nothing is added to an Amazon Linux 2 host.
echo "Disabling X11 forwarding in sshd_config on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' /etc/ssh/sshd_config"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "if sudo grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config; then printf '%s\n' '# Installed by config/host/deploy.sh' 'X11Forwarding no' | sudo tee /etc/ssh/sshd_config.d/12-blot-x11.conf >/dev/null && sudo chmod 600 /etc/ssh/sshd_config.d/12-blot-x11.conf; fi"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo sshd -t && sudo systemctl reload sshd"

echo "sshd hardening complete."
#########################################################

#########################################################
# Begin logrotate deployment section
#########################################################

LOGROTATE_LOCAL_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/logrotate"

# Upload logrotate configs
for file in "$LOGROTATE_LOCAL_DIR"/[!.]*; do
  config_name=$(basename "$file")
  echo "Uploading logrotate config $config_name to $PUBLIC_IP:/etc/logrotate.d/"
  scp -P "$SSH_PORT" -i "$SSH_KEY" "$file" ec2-user@$PUBLIC_IP:/tmp/"$config_name"
  ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/$config_name /etc/logrotate.d/$config_name && sudo chown root:root /etc/logrotate.d/$config_name && sudo chmod 644 /etc/logrotate.d/$config_name"
done

# Optionally, test logrotate config
echo "Testing logrotate config on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo logrotate --debug /etc/logrotate.conf"

echo "logrotate deployment complete."
#########################################################

#########################################################
# Begin tmpfiles deployment section
#########################################################

# /run/blot holds the app containers' Unix sockets; /run is a tmpfs, so
# systemd-tmpfiles recreates it at boot. Creating it now is safe on a running host.
echo "Installing tmpfiles.d/blot.conf on $PUBLIC_IP"
scp -P "$SSH_PORT" -i "$SSH_KEY" "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/tmpfiles.d/blot.conf" ec2-user@$PUBLIC_IP:/tmp/blot-tmpfiles.conf
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/blot-tmpfiles.conf /etc/tmpfiles.d/blot.conf && sudo chown root:root /etc/tmpfiles.d/blot.conf && sudo systemd-tmpfiles --create /etc/tmpfiles.d/blot.conf"
#########################################################

#########################################################
# Begin rsyslog deployment section
#########################################################

# app.log: the units' output, through Docker's syslog log driver to rsyslog's
# socket in /run/blot-log (made by the tmpfiles section above). See
# rsyslog/blot-app-log.conf. A config rsyslogd -N1 rejects is taken out again,
# so rsyslog keeps running on the old one. rsyslog is restarted only when the
# file changed; while it restarts, running units lose a few lines of app.log
# (`docker logs` still has them), and a unit deployed while the socket is
# missing logs to json-file instead (proxy/deploy/common.sh).
echo "Installing rsyslog/blot-app-log.conf on $PUBLIC_IP"
scp -P "$SSH_PORT" -i "$SSH_KEY" "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/rsyslog/blot-app-log.conf" ec2-user@$PUBLIC_IP:/tmp/blot-app-log.conf
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo bash -s" <<'RSYSLOG'
set -eu
target=/etc/rsyslog.d/blot-app-log.conf
# An app.log rsyslog created before the config named its owner is root's, and
# 0600 (rsyslog.service's UMask), so read.sh could not read it. rsyslog keeps
# writing to it either way.
log=/var/instance-ssd/logs/app.log
[ ! -e "$log" ] || [ "$(stat -c %U "$log")" = ec2-user ] || chown ec2-user:ec2-user "$log"
if cmp -s /tmp/blot-app-log.conf "$target"; then
  rm -f /tmp/blot-app-log.conf
  echo "rsyslog config unchanged."
  exit 0
fi
# Everything from here on runs under the unit deploy's lock
# (proxy/deploy/common.sh): Docker refuses to start a unit while the socket is
# missing, so this waits for a running unit deploy to finish, and one that
# starts during the restart refuses to run rather than failing halfway. As in
# acquire_lock there, an existing lock (another user's file in /tmp) is opened
# read-only: fs.protected_regular refuses even root a creating open of it.
lock=/tmp/blot-proxy-deploy.lock
if [ -e "$lock" ]; then
  exec 9<"$lock"
else
  exec 9>>"$lock"
  chmod 666 "$lock"
fi
if ! flock -w 900 9; then
  rm -f /tmp/blot-app-log.conf
  echo "ERROR: could not take the deploy lock $lock to restart rsyslog: is a unit deploy stuck? Nothing was changed"
  exit 1
fi
backup=$(mktemp)
had_old=0
if [ -e "$target" ]; then cp "$target" "$backup"; had_old=1; fi
put_back() {
  if [ "$had_old" = 1 ]; then cp "$backup" "$target"; else rm -f "$target"; fi
  rm -f "$backup"
}
install -m 644 -o root -g root /tmp/blot-app-log.conf "$target"
rm -f /tmp/blot-app-log.conf
if ! rsyslogd -N1 >/dev/null 2>&1; then
  rsyslogd -N1 || true
  put_back
  echo "ERROR: rsyslogd -N1 rejected blot-app-log.conf; put the old config back"
  exit 1
fi
# A failed restart puts the old config back too, so the next run tries again
# rather than finding the new one already in place
if ! systemctl restart rsyslog; then
  put_back
  systemctl restart rsyslog || true
  echo "ERROR: rsyslog did not restart with blot-app-log.conf; put the old config back"
  exit 1
fi
rm -f "$backup"
for i in 1 2 3 4 5; do [ -S /run/blot-log/app.sock ] && break; sleep 1; done
[ -S /run/blot-log/app.sock ] || { echo "ERROR: rsyslog did not create /run/blot-log/app.sock"; exit 1; }
echo "rsyslog restarted with blot-app-log.conf."
RSYSLOG
#########################################################

#########################################################
# Begin .bashrc deployment section
#########################################################

BASHRC_LOCAL_FILE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/.bashrc"

echo "Uploading .bashrc to $PUBLIC_IP:/home/ec2-user/.bashrc"
scp -P "$SSH_PORT" -i "$SSH_KEY" "$BASHRC_LOCAL_FILE" ec2-user@$PUBLIC_IP:/tmp/.bashrc
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo mv /tmp/.bashrc /home/ec2-user/.bashrc && sudo chown ec2-user:ec2-user /home/ec2-user/.bashrc && sudo chmod 644 /home/ec2-user/.bashrc"

echo ".bashrc deployment complete."
#########################################################


echo "Host setup complete. To connect to the host, run:"
echo "ssh -p $SSH_PORT -i $SSH_KEY ec2-user@$PUBLIC_IP"
