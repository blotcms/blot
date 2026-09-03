#!/usr/bin/env bash
# Start the Docker daemon inside the Cloud Agent VM and wait until it is ready.
# The VM has no systemd (PID 1 is tini), and its root filesystem is itself an
# overlay mount, so we run dockerd manually with the fuse-overlayfs graph driver
# (native overlay2 cannot be stacked on top of overlay). Idempotent: if dockerd
# already answers, it does nothing.
set -euo pipefail

if docker info >/dev/null 2>&1; then
  exit 0
fi

echo "[docker] Starting dockerd (fuse-overlayfs graph driver)"
sudo mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  echo '{ "features": { "containerd-snapshotter": false }, "storage-driver": "fuse-overlayfs" }' \
    | sudo tee /etc/docker/daemon.json >/dev/null
fi

sudo bash -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'

for i in $(seq 1 30); do
  if sudo docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! sudo docker info >/dev/null 2>&1; then
  echo "[docker] dockerd failed to start; last log lines:" >&2
  sudo tail -n 30 /var/log/dockerd.log >&2 || true
  exit 1
fi

# Let the non-root agent user talk to the daemon without sudo.
sudo chmod 666 /var/run/docker.sock || true
echo "[docker] dockerd ready"
