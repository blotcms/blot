# Blot Deployment Guide

This guide explains how to set up and use automated deployments from GitHub Actions to your EC2 instance using an SSH deploy user.

## Overview

The deployment system uses an SSH user (`deploy`) that can execute commands on the server. Security is provided by protecting the SSH key rather than restricting commands.

### Key Features

- **Full command access**: User can execute any command (security via key protection)
- **Audit logging**: All commands are logged
- **Docker access**: User can manage Docker containers
- **Automated health checks**: Automatic rollback on failure
- **Deploy-time verification**: Blue (deployed first) must also pass `verify-container` before green and yellow are touched

## Quick Start

### 1. Generate SSH Key

```bash
ssh-keygen -t ed25519 -f deploy-key -N "" -C "github-actions-deploy"
```

This creates:
- `deploy-key` (private key - add to GitHub Secrets)
- `deploy-key.pub` (public key - add to EC2 instance)

### 2. Run Setup on EC2

```bash
# Copy script to server
scp scripts/deploy/setup-deploy-user.sh ec2-user@YOUR_EC2_HOST:/tmp/

# SSH and run setup
ssh ec2-user@YOUR_EC2_HOST
sudo bash /tmp/setup-deploy-user.sh "$(cat deploy-key.pub)"
```

### 3. Add GitHub Secrets

1. **DEPLOY_SSH_KEY**: Content of `deploy-key` (private key)
2. **EC2_HOST**: Your EC2 hostname/IP

### 4. Test

```bash
ssh -i deploy-key deploy@YOUR_EC2_HOST "docker ps"
```

### 5. Deploy via GitHub Actions

Go to Actions → Deploy to EC2 → Run workflow

**Note:** The deploy user has full command access. Ensure the SSH key is properly secured in GitHub Secrets.

---

## Deploy User Setup

### Security Features

- **Key-based security**: Access is controlled by protecting the SSH private key
- **Audit logging**: All commands are logged
- **Docker access**: User can manage Docker containers
- **No command restrictions**: User can execute any command (security relies on key protection)

### Detailed Setup Instructions

#### 1. Generate SSH Key Pair

On your local machine or in GitHub Actions secrets, generate a new SSH key pair:

```bash
ssh-keygen -t ed25519 -f deploy-key -N "" -C "github-actions-deploy"
```

#### 2. Run Setup Script on EC2 Instance

Copy the setup script to your EC2 instance and run it:

```bash
# On your local machine
scp scripts/deploy/setup-deploy-user.sh ec2-user@YOUR_EC2_HOST:/tmp/

# SSH into EC2 instance
ssh ec2-user@YOUR_EC2_HOST

# Run the setup script with your public key
sudo bash /tmp/setup-deploy-user.sh "$(cat deploy-key.pub)"
```

Or if you prefer to add the key manually later:

```bash
sudo bash /tmp/setup-deploy-user.sh
# Then manually edit /home/deploy/.ssh/authorized_keys
```

#### 3. Verify Setup

Test the connection from your local machine:

```bash
ssh -i deploy-key deploy@YOUR_EC2_HOST "docker ps"
```

You should see Docker containers listed. The deploy user can execute any command.

#### 4. Configure GitHub Secrets

Add the following secrets to your GitHub repository:

1. **DEPLOY_SSH_KEY**: The private key content (`deploy-key` file)
   ```bash
   # Get the content
   cat deploy-key
   # Copy and paste into GitHub Secrets
   ```

2. **EC2_HOST**: Your EC2 instance hostname or IP address
   ```
   Example: ec2-12-34-56-78.compute-1.amazonaws.com
   Or: 12.34.56.78
   ```

### Command Access

The deploy user can execute any command on the server. There are no command restrictions. Security is provided by:

- Protecting the SSH private key in GitHub Secrets
- Limiting who has access to the GitHub repository
- Using a dedicated deployment key (not your personal SSH key)
- Regular key rotation

### Monitoring and Logs

#### Command Log

All commands executed by the deploy user are logged to:
```
/var/log/deploy-commands.log
```

View recent commands:
```bash
sudo tail -f /var/log/deploy-commands.log
```

#### SSH Access Log

SSH access attempts are logged to:
```
/var/log/deploy-ssh.log
```

#### Log Rotation

Logs are automatically rotated daily and kept for 30 days.

### Command Execution

The deploy user can execute any command without restrictions. The wrapper script is no longer used. All commands are logged to `/var/log/deploy-commands.log` for audit purposes.

### Removing the Deploy User

If you need to remove the deploy user:

```bash
sudo userdel -r deploy
sudo rm /etc/rsyslog.d/30-deploy-user.conf
sudo rm /etc/logrotate.d/deploy-user
sudo systemctl restart rsyslog
# Also remove the Match block from /etc/ssh/sshd_config
sudo systemctl restart sshd
```

## GitHub Actions Deployment

### Prerequisites

Before using the GitHub Actions deployment workflow, ensure you have:

1. **GitHub Secrets configured:**
   - `BLOT_DEPLOY_SSH_KEY`: The private SSH key for the `deploy` user on your EC2 instance
   - `BLOT_DEPLOY_SSH_HOST`: The hostname or IP address of your EC2 instance

2. **SSH Access:** The SSH key must allow the `deploy` user to:
   - Connect to the EC2 instance
   - Execute commands on the server (no restrictions)
   - Run Docker commands
   - Access `/var/www/blot/data` and `/etc/blot/secrets.env`

3. **Docker Images:** The commit you're deploying must have a corresponding Docker image built and pushed to the registry (via the `build.yml` workflow)

### How to Deploy

#### Via GitHub UI

1. Go to the **Actions** tab in your GitHub repository
2. Select **Deploy to EC2** from the workflow list
3. Click **Run workflow** to deploy the current commit

#### Via GitHub CLI

```bash
gh workflow run deploy.yml
```

**Note:** The workflow always deploys the commit that triggered it. To deploy a specific commit, navigate to that commit in GitHub first, then trigger the workflow from the Actions tab.

---

## Deploy-time container verification

Once blue reports healthy, the deploy runs `scripts/deploy/verify-container` inside it (`docker exec`). Any failed check fails the deploy: blue is rolled back and green and yellow are never touched. It checks the release ID, redis read/write, that `data/blogs` matches the blogs in redis, the data mount is writable with disk to spare, pandoc, git, sharp (with HEIC), required env vars, the airlock (browser and proxy), a render of the canary blog (`preview-of-wireframe-on-david`, straight to the container, not via the proxy) and the dashboard log-in page.

This is deliberately not part of `/health` or the Docker `HEALTHCHECK`, which also run after crash-restarts when we want to keep serving whatever we can. Rollbacks skip it for the same reason. To run it by hand:

```bash
ssh blot "docker exec blot-container-blue node /usr/src/app/scripts/deploy/verify-container/index.js <commit>"
```
