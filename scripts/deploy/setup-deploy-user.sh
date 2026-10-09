#!/bin/bash
#
# Setup script to create an SSH deploy user on the EC2 instance
# Run this script on the EC2 instance as root or with sudo
#
# Usage:
#   sudo ./setup-deploy-user.sh [PUBLIC_KEY]
#
# If PUBLIC_KEY is not provided, you'll need to add it manually to
# /home/deploy/.ssh/authorized_keys after running this script
#
# Note: This script does not restrict commands. Secure the SSH key instead.

set -euo pipefail

DEPLOY_USER="deploy"
DEPLOY_HOME="/home/${DEPLOY_USER}"
SSH_DIR="${DEPLOY_HOME}/.ssh"
WRAPPER_SCRIPT="/usr/local/bin/deploy-wrapper.sh"
AUDIT_LOG="/var/log/deploy-ssh.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    error "Please run as root or with sudo"
fi

log "Setting up deploy user: ${DEPLOY_USER}"

# Create deploy user if it doesn't exist
if id "${DEPLOY_USER}" &>/dev/null; then
    warn "User ${DEPLOY_USER} already exists"
else
    log "Creating user ${DEPLOY_USER}..."
    useradd -m -s /bin/bash "${DEPLOY_USER}" || error "Failed to create user"
fi

# Create SSH directory
log "Setting up SSH directory..."
mkdir -p "${SSH_DIR}"
chmod 700 "${SSH_DIR}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${SSH_DIR}"

# Create authorized_keys
log "Setting up SSH authorized_keys..."
if [ -n "${1:-}" ]; then
    PUBLIC_KEY="$1"
    log "Adding provided public key..."
    cat > "${SSH_DIR}/authorized_keys" <<EOF
# GitHub Actions deploy key
# Added: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
${PUBLIC_KEY}
EOF
    chmod 600 "${SSH_DIR}/authorized_keys"
    chown "${DEPLOY_USER}:${DEPLOY_USER}" "${SSH_DIR}/authorized_keys"
    log "Public key added to authorized_keys"
else
    warn "No public key provided. You'll need to manually add it to:"
    warn "  ${SSH_DIR}/authorized_keys"
    warn "Format:"
    warn "  ssh-rsa YOUR_KEY_HERE"
    touch "${SSH_DIR}/authorized_keys"
    chmod 600 "${SSH_DIR}/authorized_keys"
    chown "${DEPLOY_USER}:${DEPLOY_USER}" "${SSH_DIR}/authorized_keys"
fi

# Add deploy user to docker group (so it can run docker without sudo)
log "Adding ${DEPLOY_USER} to docker group..."
if getent group docker > /dev/null 2>&1; then
    usermod -aG docker "${DEPLOY_USER}" || warn "Failed to add to docker group (docker may not be installed)"
else
    warn "Docker group not found - docker may not be installed"
fi

# The proxy deploy scripts read /etc/blot/proxy.env, which can hold
# BLOT_PURGE_TOKEN, so grant read with an ACL rather than making it world-readable
PROXY_ENV="/etc/blot/proxy.env"
if [ -f "${PROXY_ENV}" ]; then
    log "Granting ${DEPLOY_USER} read access to ${PROXY_ENV}..."
    setfacl -m "u:${DEPLOY_USER}:r" "${PROXY_ENV}" 2>/dev/null || warn "Could not set an ACL on ${PROXY_ENV} (is setfacl installed?): run: sudo setfacl -m u:${DEPLOY_USER}:r ${PROXY_ENV}"
else
    log "${PROXY_ENV} does not exist yet: once created, grant ${DEPLOY_USER} read access (see proxy/deploy/README.md)"
fi

# Set up audit logging
log "Setting up audit logging..."
touch "${AUDIT_LOG}"
chmod 640 "${AUDIT_LOG}"
chown root:adm "${AUDIT_LOG}" 2>/dev/null || chown root:root "${AUDIT_LOG}"

# Create command log file
COMMAND_LOG="/var/log/deploy-commands.log"
touch "${COMMAND_LOG}"
chmod 640 "${COMMAND_LOG}"
chown root:adm "${COMMAND_LOG}" 2>/dev/null || chown root:root "${COMMAND_LOG}"

# Configure rsyslog to log SSH access (if rsyslog is available)
if command -v rsyslogd &> /dev/null; then
    log "Configuring rsyslog for deploy user monitoring..."
    cat > /etc/rsyslog.d/30-deploy-user.conf <<EOF
# Log SSH access by deploy user
:msg, contains, "deploy" ${AUDIT_LOG}
& stop
EOF
    systemctl restart rsyslog 2>/dev/null || warn "Could not restart rsyslog"
fi

# Set up log rotation
log "Setting up log rotation..."
cat > /etc/logrotate.d/deploy-user <<EOF
${AUDIT_LOG}
${COMMAND_LOG} {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 640 root adm
}
EOF

# Configure SSH for deploy user (optional - no command restrictions)
log "Configuring SSH settings..."
if [ -f /etc/ssh/sshd_config ]; then
    # Check if Match block already exists
    if ! grep -q "Match User ${DEPLOY_USER}" /etc/ssh/sshd_config; then
        cat >> /etc/ssh/sshd_config <<EOF

# Settings for deploy user (no command restrictions)
Match User ${DEPLOY_USER}
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding no
    PermitTunnel no
EOF
        log "SSH configuration updated. Restart SSH service to apply changes:"
        warn "  sudo systemctl restart sshd"
        warn "  (or test with: sudo sshd -t)"
    else
        warn "SSH Match block for ${DEPLOY_USER} already exists"
    fi
else
    warn "SSH config file not found at /etc/ssh/sshd_config"
fi

log ""
log "=========================================="
log "Deploy user setup complete!"
log "=========================================="
log ""
log "User: ${DEPLOY_USER}"
log "Home: ${DEPLOY_HOME}"
log "SSH Key: ${SSH_DIR}/authorized_keys"
log "Wrapper: ${WRAPPER_SCRIPT}"
log "Audit Log: ${AUDIT_LOG}"
log "Command Log: ${COMMAND_LOG}"
log ""
if [ -z "${1:-}" ]; then
    warn "Don't forget to add the public key to:"
    warn "  ${SSH_DIR}/authorized_keys"
fi
log ""
warn "Next steps:"
warn "1. Add the GitHub Actions SSH private key as a secret: DEPLOY_SSH_KEY"
warn "2. Add the EC2 hostname/IP as a secret: EC2_HOST"
warn "3. Test the connection: ssh -i /path/to/key deploy@HOST 'docker ps'"
warn "4. Restart SSH service if you modified sshd_config"
warn "5. Proxy deploys: ${DEPLOY_USER} must be able to read ${PROXY_ENV} (see proxy/deploy/README.md)"
log ""

