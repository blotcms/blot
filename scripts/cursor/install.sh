#!/usr/bin/env bash
# One-time setup for the Blot Cloud Agent dev environment. Installs the system
# tooling the repo's Docker Compose workflow needs, brings up the daemons, and
# pre-builds the Compose images so future agent boots are fast. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/../.." && pwd)"
cd "$REPO_DIR"

# 1. System packages: Docker Engine + Compose v2, mkcert (+ NSS tools for Chrome
#    trust), fuse-overlayfs (nested overlay graph driver) and dnsmasq.
if ! command -v docker >/dev/null 2>&1 \
  || ! command -v mkcert >/dev/null 2>&1 \
  || ! command -v dnsmasq >/dev/null 2>&1; then
  sudo apt-get update -y
  # -o Dpkg::Options::=--force-conf* keeps existing conffiles without prompting;
  # otherwise installing fuse3 stops on the /etc/fuse.conf conffile prompt (no
  # tty in the build/setup environment) and aborts the whole install.
  sudo apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    docker.io docker-compose-v2 mkcert libnss3-tools \
    fuse-overlayfs dnsmasq-base ca-certificates curl
fi

# 2. Docker daemon config: classic graph driver with fuse-overlayfs. The VM root
#    is an overlay mount, so native overlay2 cannot be stacked on top of it.
sudo mkdir -p /etc/docker
echo '{ "features": { "containerd-snapshotter": false }, "storage-driver": "fuse-overlayfs" }' \
  | sudo tee /etc/docker/daemon.json >/dev/null

# 3. Let the agent user use the Docker socket without sudo.
sudo groupadd -f docker
sudo usermod -aG docker "$(id -un)" || true

# 4. Bring up the daemons (dockerd, dnsmasq), disable bridge netfilter, and
#    generate the wildcard TLS certificate.
bash "$DIR/start.sh"

# 5. Pre-build the Compose images (node-app, nginx, toxiproxy) so agent boots do
#    not have to compile native modules (sharp) or download Pandoc each time.
touch "$REPO_DIR/.env"
BLOT_HOST=local.blot COMPOSE_BAKE=true \
  docker compose -f scripts/development/docker-compose.yml build

echo "[install] Blot dev environment setup complete"
