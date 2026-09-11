#!/bin/bash
set -euo pipefail

# The optional directory lets provisioning tests inspect generated units without
# touching the host's systemd configuration.
unit_dir="${1:-/etc/systemd/system}"
mkdir -p "$unit_dir/redis6.service.d"

# Mount preparation needs root privileges; Redis itself keeps its packaged
# service user. A separate dependency avoids putting service commands in [Unit]
# or ordering redis6.service against itself.
cat > "$unit_dir/blot-redis-backups-mount.service" <<'EOF'
[Unit]
Description=Prepare Blot Redis backup storage
Before=redis6.service

[Service]
Type=oneshot
ExecStart=/bin/bash /home/ec2-user/scripts/mount-instance-store.sh
RemainAfterExit=yes
EOF

cat > "$unit_dir/redis6.service.d/override.conf" <<'EOF'
[Unit]
Requires=blot-redis-backups-mount.service
After=blot-redis-backups-mount.service

[Service]
Restart=always
EOF
