#!/usr/bin/env bash
# Blot uses a large number of subdomains under the fake ".blot" TLD
# (local.blot, cdn.local.blot, <handle>.local.blot, ...). Point every ".blot"
# name at the loopback address via dnsmasq, while forwarding all other queries
# to the VM's original upstream resolver. Idempotent.
set -euo pipefail

UPSTREAM="$(grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | grep -v '127.0.0.1' | awk '{print $2}' | head -n1)"
UPSTREAM="${UPSTREAM:-8.8.8.8}"

sudo bash -c "cat > /etc/dnsmasq-blot.conf <<EOF
listen-address=127.0.0.1
bind-interfaces
no-resolv
address=/blot/127.0.0.1
server=${UPSTREAM}
EOF"

if ! pgrep -x dnsmasq >/dev/null 2>&1; then
  echo "[dns] Starting dnsmasq (*.blot -> 127.0.0.1, upstream ${UPSTREAM})"
  sudo bash -c 'nohup dnsmasq --conf-file=/etc/dnsmasq-blot.conf --no-daemon >/var/log/dnsmasq-blot.log 2>&1 &'
  sleep 1
fi

# Route DNS through dnsmasq first, keep upstream as a fallback.
if ! grep -q '^nameserver 127.0.0.1' /etc/resolv.conf 2>/dev/null; then
  sudo bash -c "printf 'nameserver 127.0.0.1\nnameserver %s\n' '${UPSTREAM}' > /etc/resolv.conf"
fi

echo "[dns] local.blot -> $(getent hosts local.blot | awk '{print $1}' | head -n1)"
