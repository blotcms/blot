#!/bin/sh

# This should only be run once, when the instance is launched
# It will only work when run as root

SCRIPTS_DIRECTORY=/home/ec2-user/node/scripts
PANDOC_URL=https://github.com/jgm/pandoc/releases/download/3.1.1/pandoc-3.1.1-linux-arm64.tar.gz
BLOT_DIRECTORY=/var/www/blot
BLOT_REPO=https://github.com/blotcms/blot


if [ ! -d "/home/ec2-user/node/scripts" ]; then
  echo "The directory /home/ec2-user/node/scripts does not exist"
  exit 1
fi

# install cron
yum install -y cronie
systemctl start crond
systemctl enable crond
chkconfig crond on

# packages required to get npm install working
yum install -y make 
yum install -y gcc
yum install -y gcc-c++

# for sharp and pngquant
yum install -y libpng
yum install -y libpng-devel

# for pupeteer
amazon-linux-extras install firefox

# Install Blot
# Install git and ntp
# What is ntp required for?
yum -y install git ntp

## Pandoc installation
##########################################################

cd $SCRIPTS_DIRECTORY

# Install Pandoc only if the binary is not already installed
if ! command -v pandoc &> /dev/null
then
  mkdir pandoc
  wget $PANDOC_URL -O pandoc.tar.gz
  tar -xvzf pandoc.tar.gz --strip-components 1 -C pandoc
  cp pandoc/bin/pandoc /usr/bin
  rm pandoc.tar.gz
  rm -rf ./pandoc
fi

# print the pandoc version or exit if pandoc is not installed
if ! command -v pandoc &> /dev/null
then
  echo "pandoc could not be found"
  exit 1
fi

pandoc --version

echo "preparing blot directory..."

rm -rf $BLOT_DIRECTORY
mkdir -p $BLOT_DIRECTORY
chown -R ec2-user:ec2-user $BLOT_DIRECTORY

echo "Setting up cron job to renew certificates..."
yum install -y pyOpenSSL python-crypto python-setuptools libffi-devel python3-devel
yum groupinstall -y "Development tools"
rm -rf acme-nginx
git clone https://github.com/kshcherban/acme-nginx
cd acme-nginx

python3 setup.py install

# change default font
git clone https://github.com/sahibjotsaggu/San-Francisco-Pro-Fonts.git
mkdir -p /usr/share/fonts/sanfrancisco
cp -r San-Francisco-Pro-Fonts/* /usr/share/fonts/sanfrancisco
fc-cache -f -v
mkdir -p ~/.config/fontconfig

# install the following to fonts.conf
# <?xml version='1.0'?>
# <!DOCTYPE fontconfig SYSTEM 'fonts.dtd'>
# <fontconfig>
# <alias>
#     <family>sans-serif</family>
#     <prefer><family>SF Pro Text</family></prefer>
#   </alias>
# </fontconfig>
echo "<?xml version='1.0'?>
<!DOCTYPE fontconfig SYSTEM 'fonts.dtd'>
<fontconfig>
<alias>
    <family>sans-serif</family>
    <prefer><family>SF Pro Text</family></prefer>
  </alias>
</fontconfig>" > ~/.config/fontconfig/fonts.conf

# check that the alias is working
fc-match sans-serif


echo "Installing Blot..."

mkdir -p $BLOT_DIRECTORY

# We use a shallow clone to reduce required disk space
git clone --depth 1 -b master --single-branch $BLOT_REPO $BLOT_DIRECTORY

# copy the env file from existing node server
mkdir -p /etc/blot
scp -P $CURRENT_NODE_SSH_PORT -i $SCRIPTS_DIRECTORY/projects.pem ec2-user@$CURRENT_NODE_IP:/etc/blot/environment.sh /etc/blot/environment.sh
chown -R ec2-user:ec2-user /etc/blot

chown -R ec2-user:ec2-user $BLOT_DIRECTORY

# Install the tool used to list the disks used by mount-data-disk.sh
yum install -y nvme-cli

cp $SCRIPTS_DIRECTORY/mount-data-disk.service /etc/systemd/system/mount-data-disk.service

# reload systemd
systemctl daemon-reload

# start and enable the mount-instance-store service
systemctl start mount-data-disk
systemctl enable mount-data-disk

# TODO:
# edit /etc/systemd/journald.conf
# uncomment and change the following line
# SystemMaxUse=1G


# Create a systemd service for the blot application using the file ./node.service
cp $SCRIPTS_DIRECTORY/node.service /etc/systemd/system/node.service
systemctl daemon-reload

amazon-linux-extras install epel -y
