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

# Optional: the EBS volume ID of the data volume, for a host that has no
# /etc/blot/data-volume yet (see the data volume section below).
DATA_VOLUME_ID="${DATA_VOLUME_ID:-}"
if [ -n "$DATA_VOLUME_ID" ] && ! printf '%s\n' "$DATA_VOLUME_ID" | grep -Eq '^vol-[0-9a-f]{8,17}$'; then
  echo "DATA_VOLUME_ID must look like vol-0a2e04d301e025e60"
  exit 1
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
echo "Installing mount-instance-store.service and its docker.service.d drop-in on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-instance-store.service /etc/systemd/system/mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/10-instance-store.conf /etc/systemd/system/docker.service.d/10-instance-store.conf"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl enable mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "mountpoint -q /var/instance-ssd || sudo systemctl start mount-instance-store.service"
echo "mount-instance-store / docker.service ordering installed."

# On a new combined host host/setup.sh ran before the instance store was
# mounted, so blot-instance-store.service (Redis's /backups, a bind mount of a
# directory of it) failed then. Start it now. Nothing happens where the unit
# does not exist (the Amazon Linux 2 app host) or /backups is already mounted.
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "if [ -e /etc/systemd/system/blot-instance-store.service ] && ! mountpoint -q /backups; then sudo systemctl start blot-instance-store.service || echo \"WARNING: /backups is not mounted; see journalctl -u blot-instance-store\"; fi"

# Install (or update) the mount-data-volume unit and its docker.service
# drop-in, the same way: docker must not (re)start at boot against an unmounted,
# empty /var/www/blot/data on the root disk. Again no docker restart here.
#
# /etc/blot/data-volume (the expected EBS volume ID) and the .blot-data-volume
# marker on the volume are host state, so the first run on a host that
# already has the volume mounted adopts it: it works out which volume that is
# from the mounted device and writes both. They are only written when missing,
# so a later run never overwrites what a volume swap put there. Starting the
# unit afterwards is safe on a running host: with the right volume already
# mounted the script verifies the device and exits 0 without touching it.
#
# A new host has no volume mounted to adopt from: pass DATA_VOLUME_ID and it is
# written to /etc/blot/data-volume, also only when that file is missing. If a
# volume is mounted and it is not that one, nothing is written. The marker is
# only ever written for the volume that is mounted: a volume that is not
# mounted yet needs its own marker, put there before the unit mounts it.
echo "Installing mount-data-volume.service and its docker.service.d drop-in on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-data-volume.service /etc/systemd/system/mount-data-volume.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/20-data-volume.conf /etc/systemd/system/docker.service.d/20-data-volume.conf"

ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo env DATA_VOLUME_ID='$DATA_VOLUME_ID' bash -s" <<'ADOPT'
set -eu
DATA_DIRECTORY=/var/www/blot/data
VOLUME_ID_FILE=/etc/blot/data-volume
LINK_PREFIX=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol

if [ ! -f "$VOLUME_ID_FILE" ] && mountpoint -q "$DATA_DIRECTORY"; then
  # findmnt prints bind-mounted sources as /dev/xxx[/subdir]; drop the [...]
  SOURCE=$(findmnt -n -o SOURCE --target "$DATA_DIRECTORY")
  MOUNTED_DEVICE=$(readlink -f "${SOURCE%%[*}")
  FOUND=""
  for link in "$LINK_PREFIX"*; do
    [ -e "$link" ] || continue
    case "$link" in *-ns-*|*-part*) continue ;; esac
    if [ "$(readlink -f "$link")" = "$MOUNTED_DEVICE" ]; then
      FOUND="vol-${link#"$LINK_PREFIX"}"
      break
    fi
  done

  if [ -n "${DATA_VOLUME_ID:-}" ] && [ "$FOUND" != "$DATA_VOLUME_ID" ]; then
    echo "ERROR: $DATA_DIRECTORY is mounted from $MOUNTED_DEVICE (${FOUND:-no matching EBS volume}), not DATA_VOLUME_ID=$DATA_VOLUME_ID."
    exit 1
  fi

  if [ -n "$FOUND" ]; then
    mkdir -p /etc/blot
    echo "$FOUND" > "$VOLUME_ID_FILE"
    echo "Adopted $MOUNTED_DEVICE mounted at $DATA_DIRECTORY as $FOUND ($VOLUME_ID_FILE written)."
    if [ ! -f "$DATA_DIRECTORY/.blot-data-volume" ]; then
      echo "$FOUND" > "$DATA_DIRECTORY/.blot-data-volume"
      echo "Wrote $DATA_DIRECTORY/.blot-data-volume."
    fi
  else
    echo "WARNING: $DATA_DIRECTORY is mounted from $MOUNTED_DEVICE but no EBS volume in /dev/disk/by-id matches it."
  fi
fi

if [ ! -f "$VOLUME_ID_FILE" ] && [ -n "${DATA_VOLUME_ID:-}" ]; then
  mkdir -p /etc/blot
  echo "$DATA_VOLUME_ID" > "$VOLUME_ID_FILE"
  echo "Wrote $DATA_VOLUME_ID to $VOLUME_ID_FILE."
elif [ -f "$VOLUME_ID_FILE" ] && [ -n "${DATA_VOLUME_ID:-}" ]; then
  echo "$VOLUME_ID_FILE already exists; DATA_VOLUME_ID was not written."
fi

if [ ! -f "$VOLUME_ID_FILE" ]; then
  echo "WARNING: $VOLUME_ID_FILE does not exist and no data volume could be adopted from $DATA_DIRECTORY."
  echo "Re-run with DATA_VOLUME_ID set to the data volume's ID (e.g. vol-0a2e04d301e025e60), and put the same ID in .blot-data-volume at the root of the volume."
fi
ADOPT

# Remove the legacy mount-data-disk unit: its script was never part of this
# directory and no longer exists on the host, so the unit only fails at boot.
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "if [ -f /etc/systemd/system/mount-data-disk.service ]; then sudo systemctl disable mount-data-disk.service || true; sudo rm -f /etc/systemd/system/mount-data-disk.service; fi"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload && sudo systemctl reset-failed mount-data-disk.service 2>/dev/null || true"

if ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "test -f /etc/blot/data-volume"; then
  ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl enable --now mount-data-volume.service"
  echo "mount-data-volume / docker.service ordering installed and unit enabled."
else
  echo "WARNING: /etc/blot/data-volume is missing on $PUBLIC_IP, so mount-data-volume.service was NOT enabled."
fi

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
