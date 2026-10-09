
# command to sync folders 
rsync -azvv --exclude "/node_modules" --exclude "/logs" --exclude "/tmp" -e "ssh -i projects.pem" ec2-user@54.191.179.131:/var/www/blot/ /var/www/blot

- It seems that A1 instances do not support Amazon Linux 2023 but do support AL2

cron scripts for ec2-user:
1 0 * * * /var/www/blot/scripts/log-rotate.sh

cron scripts for root:
1 0 * * * /var/www/blot/scripts/log-rotate.sh
0 9 1 * * /var/www/blot/scripts/production/renew_wildcard_ssl.sh >> /var/log/letsencrypt.log 2>&1


