#!/bin/bash

# Exit immediately if any command fails
set -e

# Exit with an error if we're not on the master branch
if [[ $(git rev-parse --abbrev-ref HEAD) != "master" ]]; then
  echo "Error: You must be on the master branch to deploy new code to the mac server."
  echo "Please switch to the master branch and try again."
  exit 1
fi

# Determine the GIT_COMMIT_HASH based on the arguments provided
if [[ $# -eq 0 ]]; then
  # No argument provided, use the most recent commit
  GIT_COMMIT_HASH=$(git rev-parse master)
elif [[ $# -eq 1 ]]; then
  # One argument provided, check if it's a valid commit hash
  ARG=$1

  if [[ ${#ARG} -eq 40 && $ARG =~ ^[0-9a-fA-F]{40}$ ]]; then
    # Full-length hash provided
    GIT_COMMIT_HASH=$ARG
  elif [[ ${#ARG} -lt 40 && $ARG =~ ^[0-9a-fA-F]+$ ]]; then
    # Short hash provided, resolve it to full length
    GIT_COMMIT_HASH=$(git rev-parse "$ARG")
  else
    echo "Error: Invalid commit hash provided."
    exit 1
  fi
else
  echo "Error: Too many arguments provided."
  echo "Usage: $0 [commit-hash]"
  exit 1
fi

# Print the commit hash and the commit message
echo "Deploying commit: $GIT_COMMIT_HASH"
echo "Commit message: $(git log -1 --pretty=%B $GIT_COMMIT_HASH)"

# Ask for confirmation
read -p "Are you sure you want to deploy this commit? (y/n): " CONFIRMATION

if [[ "$CONFIRMATION" != "y" ]]; then
  echo "Deployment canceled."
  exit 0
fi

REMOTE_CODE_DIRECTORY=/Users/admin/blot

# Function to run a command over SSH
ssh_macserver() {
  ssh macserver "$@" || { echo "SSH command failed: $@"; exit 1; }
}

# Restart the application using PM2 with nvm loaded
echo "Restarting the macserver process with PM2..."
ssh_macserver "export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\" && cd $REMOTE_CODE_DIRECTORY && git pull && rm package-lock.json && npm install && pm2 restart macserver"

echo "Deployment completed successfully!"