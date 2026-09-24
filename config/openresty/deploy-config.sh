#!/bin/sh

# this exits the script if any command fails
set -e

if [ -z "$SSH_KEY" ]; then
  echo "SSH_KEY variable missing, pass the path to the key as an argument to this script"
  exit 1
fi

# ssh port of the openresty instance, defaults to 22
SSH_PORT="${SSH_PORT:-22}"

if [ -z "$PUBLIC_IP" ]; then
  echo "PUBLIC_IP variable missing, pass the public ip address of the openresty instance as an argument to this script"
  exit 1
fi

if [ -z "$NODE_SERVER_IP" ]; then
  echo "NODE_SERVER_IP variable missing, pass the ip address of the node instance as an argument to this script"
  exit 1
fi

if [ -z "$REDIS_IP" ]; then
  echo "REDIS_IP variable missing, pass the ip address of the redis instance as an argument to this script"
  exit 1
fi


# build the openresty config files
echo "Building openresty config files..."
BUILD_SCRIPT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/build-config.js"
node $BUILD_SCRIPT

# upload all the built in the directory './data/latest'  
DATA_DIRECTORY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/data/latest"
echo "Uploading $DATA_DIRECTORY to ~/openresty on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "rm -rf /home/ec2-user/openresty"
scp -P "$SSH_PORT" -i $SSH_KEY -r $DATA_DIRECTORY ec2-user@$PUBLIC_IP:/home/ec2-user/openresty

#upload the scripts to the openresty server
SCRIPTS_DIRECTORY="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/scripts"
echo "Uploading $SCRIPTS_DIRECTORY to ~/scripts on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "rm -rf /home/ec2-user/scripts"
scp -P "$SSH_PORT" -i $SSH_KEY -r $SCRIPTS_DIRECTORY ec2-user@$PUBLIC_IP:/home/ec2-user/scripts
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "chmod +x /home/ec2-user/scripts/*"

# Install (or update) the mount-instance-store unit and the docker.service /
# openresty.service drop-ins that gate on it, so neither can (re)start at
# boot against the not-yet-mounted, empty /var/instance-ssd. Only installs
# files + daemon-reload: it must NOT restart docker.service, openresty.service
# or mount-instance-store.service here, since all are live on a running host
# (restarting docker would kill the running containers, restarting the mount
# unit would unmount the cache under them) and daemon-reload alone is safe
# against a running unit. The new ordering takes effect at the next reboot.
echo "Installing mount-instance-store.service and its docker.service.d/openresty.service.d drop-ins on $PUBLIC_IP"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo cp /home/ec2-user/scripts/mount-instance-store.service /etc/systemd/system/mount-instance-store.service"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo mkdir -p /etc/systemd/system/docker.service.d /etc/systemd/system/openresty.service.d && sudo cp /home/ec2-user/scripts/docker.service.d/10-instance-store.conf /etc/systemd/system/docker.service.d/10-instance-store.conf && sudo cp /home/ec2-user/scripts/openresty.service.d/10-instance-store.conf /etc/systemd/system/openresty.service.d/10-instance-store.conf"
ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo systemctl daemon-reload"
echo "mount-instance-store / docker.service / openresty.service ordering installed (takes effect on next boot)."

# Once the proxy runs as a container (proxy/deploy) the bare-metal openresty is
# stopped, and its config is no longer what serves traffic: reloading it would
# fail (and, with set -e, skip everything below). Config for the container ships
# in its image via proxy/deploy/blue-green.sh, so only validate here.
if ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "docker ps --format '{{.Names}}' | grep -qE '^blot-proxy-(blue|green)\$'"; then
  echo "A proxy container is serving: not reloading bare-metal openresty."
  echo "Deploy proxy config changes with proxy/deploy/blue-green.sh instead."
  # The bare-metal copy is the rollback target: still make sure it parses.
  ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo openresty -t"
else
  echo "Reloading openresty...."
  ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo openresty -t"
  ssh -p "$SSH_PORT" -i $SSH_KEY ec2-user@$PUBLIC_IP "sudo openresty -s reload"
  echo "Reload complete."
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


echo "Deploy complete. To connect to the openresty server, run:"
echo "ssh -p $SSH_PORT -i $SSH_KEY ec2-user@$PUBLIC_IP"
