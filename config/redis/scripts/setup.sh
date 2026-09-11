#!/bin/bash

# This should only be run once, when the instance is launched
# It will only work when run as root

# the cron scripts are in the home directory of the user 'ec2-user'
# throw an error if they don't exist
if [ ! -d "/home/ec2-user/scripts" ]; then
  echo "The directory /home/ec2-user/scripts does not exist"
  exit 1
fi

# The following are recommendations for improving the performance
# of Redis on an AWS instance.
# TODO: fully research each line and document it. Ensure each change
# is persisted across reboot and hard stop/start
sysctl vm.overcommit_memory=1
bash -c "echo never > /sys/kernel/mm/transparent_hugepage/enabled"
dd if=/dev/zero of=/swapfile1 bs=1024 count=4194304

# install redis
dnf install -y redis6

# Keep mount preparation in a root-owned dependency and Redis service settings
# in the service drop-in, without overwriting one section with another.
/bin/bash "$(dirname "$0")/install-service-overrides.sh" || exit $?

systemctl daemon-reload || exit $?

# Start only after the mount dependency and restart policy are installed.
systemctl start redis6
systemctl enable redis6
chkconfig redis6 on

# update redis configuration so it listens on all interfaces
# we lock down the instance using AWS security groups
# the configuration file is stored in /etc/redis6/redis6.conf
echo -e "config set bind 0.0.0.0\nconfig set protected-mode no\nconfig rewrite" | redis6-cli

systemctl restart redis6

# check that the redis server is listening
if [[ $(redis6-cli ping) != "PONG" ]]; then
  echo "Redis is not listening"
  exit 1
fi

# install cron
yum install -y cronie
systemctl start crond
systemctl enable crond
chkconfig crond on

# protect ssh brute force attacks with fail2ban
yum -y install fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# install the backup scripts in cron
cat > /etc/cron.d/blot-redis-backups <<'EOF'
# m h dom mon dow user command
0 * * * * root /home/ec2-user/scripts/hourly-backup.sh >> /home/ec2-user/backup.log 2>&1
0 3 * * * root /home/ec2-user/scripts/daily-backup.sh >> /home/ec2-user/backup.log 2>&1
0 0 1 * * root : > /home/ec2-user/backup.log
EOF
chmod 0644 /etc/cron.d/blot-redis-backups

# run the script /home/ec2-user/scripts/mount-instance-store.sh
# to mount the instance store if it's not already
/home/ec2-user/scripts/mount-instance-store.sh

# change the ssh port from 22 to random port between 1024 and 65535
# overwriting /etc/ssh/sshd_config

# limit the SystemMaxUse of the journal to 100M
# overwriting /etc/systemd/journald.conf
# and then restart the systemd-journald service
