#!/bin/sh

# Host setup for the production proxy host: the certificate and health-check
# scripts in ./scripts, systemd ordering, fail2ban, logrotate, sshd and
# .bashrc. The proxy itself is a container: deploy it with
# `npm run deploy-proxy` (scripts/deploy/proxy.sh). Run it with
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


#upload the scripts to the proxy host
SCRIPTS_DIRECTORY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/scripts"
echo "Uploading $SCRIPTS_DIRECTORY to ~/scripts on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "rm -rf /home/ec2-user/scripts"
scp -P "$SSH_PORT" -i $SSH_KEY -r $SCRIPTS_DIRECTORY ec2-user@$PUBLIC_IP:/home/ec2-user/scripts
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "chmod +x /home/ec2-user/scripts/*"

# Install (or update) the mount-instance-store unit and the docker.service
# drop-in that gates on it, so docker cannot (re)start at boot against the
# not-yet-mounted, empty /var/instance-ssd. Only installs files +
# daemon-reload: it must NOT restart docker.service or
# mount-instance-store.service here, since all are live on a running host
# (restarting docker would kill the running containers, restarting the mount
# unit would unmount the cache under them) and daemon-reload alone is safe
# against a running unit. The new ordering takes effect at the next reboot.
echo "Installing mount-instance-store.service and its docker.service.d drop-in on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-instance-store.service /etc/systemd/system/mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/10-instance-store.conf /etc/systemd/system/docker.service.d/10-instance-store.conf"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload"
echo "mount-instance-store / docker.service ordering installed (takes effect on next boot)."

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
echo "Installing mount-data-volume.service and its docker.service.d drop-in on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-data-volume.service /etc/systemd/system/mount-data-volume.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/20-data-volume.conf /etc/systemd/system/docker.service.d/20-data-volume.conf"

ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo bash -s" <<'ADOPT'
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

if [ ! -f "$VOLUME_ID_FILE" ]; then
  echo "WARNING: $VOLUME_ID_FILE does not exist and no data volume could be adopted from $DATA_DIRECTORY."
  echo "Create it with the data volume's ID (e.g. vol-0a2e04d301e025e60), put the same ID in .blot-data-volume at the root of the volume, then re-run."
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

# Restart fail2ban
echo "Restarting fail2ban on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo systemctl restart fail2ban"

echo "Fail2Ban deployment complete."
#########################################################

#########################################################
# Begin sshd hardening section
#########################################################

echo "Disabling X11 forwarding in sshd_config on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i "$SSH_KEY" ec2-user@$PUBLIC_IP "sudo sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' /etc/ssh/sshd_config && sudo sshd -t && sudo systemctl reload sshd"

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
