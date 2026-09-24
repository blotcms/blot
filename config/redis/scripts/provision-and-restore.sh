#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSFER_SCRIPT="${SCRIPT_DIR%/}/../transfer.sh"
LOG_FILE="${SCRIPT_DIR%/}/provisioned-instances.log"
DEFAULT_REGION="us-west-2"
LAUNCH_TEMPLATE_ID="lt-09f38dac82c204d58"
REQUIRED_SECURITY_GROUP="sg-0b3b200323d36ce2e"
SNAPSHOT_BUCKET="blot-redis-backups"
SNAPSHOT_PREFIX="daily/"
TAG_PROVISIONED_BY="redis-restore-script"
DEFAULT_BLOT_HOST="blot"

AWS_PROFILE=${AWS_PROFILE:-default}
AWS_REGION=${AWS_REGION:-$DEFAULT_REGION}
SSH_KEY=${REDIS_SSH_KEY:-${SSH_KEY:-}}
SSH_USER=${SSH_USER:-ec2-user}
BLOT_HOST=${BLOT_HOST:-$DEFAULT_BLOT_HOST}
DRY_RUN=false

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --profile PROFILE       AWS CLI profile to use (default: ${AWS_PROFILE})
  --region REGION         AWS region to use (default: ${AWS_REGION})
  --ssh-key PATH          Path to the SSH private key for the Redis instance
  --ssh-user USER         SSH username for the Redis instance (default: ${SSH_USER})
  --blot-host HOST        SSH alias for the primary Blot server (default: ${BLOT_HOST})
  --dry-run               Print actions without creating resources
  -h, --help              Show this help message

Environment variables:
  AWS_PROFILE, AWS_REGION
  REDIS_SSH_KEY or SSH_KEY
  SSH_USER
  BLOT_HOST
  AWS_KEY, AWS_SECRET (optional remote credentials for transfer.sh)
USAGE
}

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
error() { printf '[ERROR] %s\n' "$*" >&2; }

confirm() {
  local prompt=${1:-Confirm?}
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) return 1 ;;
  esac
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Required command '$1' not found in PATH"
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      AWS_PROFILE="$2"; shift 2 ;;
    --region)
      AWS_REGION="$2"; shift 2 ;;
    --ssh-key)
      SSH_KEY="$2"; shift 2 ;;
    --ssh-user)
      SSH_USER="$2"; shift 2 ;;
    --blot-host)
      BLOT_HOST="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      error "Unknown argument: $1"
      usage
      exit 1 ;;
  esac
  if [ "${1:-}" = "" ]; then
    break
  fi
done

require_command aws
require_command ssh
require_command scp
require_command sed
require_command python3

if [ ! -x "$TRANSFER_SCRIPT" ]; then
  error "transfer.sh is missing or not executable at $TRANSFER_SCRIPT"
  exit 1
fi

AWS_BASE=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")

info "Listing backups in s3://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}"
MAX_SNAPSHOTS=${MAX_SNAPSHOTS:-20}
mapfile -t snapshot_lines < <(
  AWS_PROFILE="$AWS_PROFILE" \
  AWS_REGION="$AWS_REGION" \
  SNAPSHOT_BUCKET="$SNAPSHOT_BUCKET" \
  SNAPSHOT_PREFIX="$SNAPSHOT_PREFIX" \
  MAX_SNAPSHOTS="$MAX_SNAPSHOTS" \
  python3 <<'PY'
import json
import os
import subprocess
import sys

bucket = os.environ["SNAPSHOT_BUCKET"]
prefix = os.environ["SNAPSHOT_PREFIX"]
profile = os.environ.get("AWS_PROFILE", "")
region = os.environ.get("AWS_REGION", "")
max_snapshots = int(os.environ.get("MAX_SNAPSHOTS", "20"))

base_cmd = ["aws"]
if profile:
    base_cmd.extend(["--profile", profile])
if region:
    base_cmd.extend(["--region", region])
base_cmd.extend([
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--prefix",
    prefix,
    "--max-keys",
    "1000",
])

items = []
continuation = None

while True:
    cmd = list(base_cmd)
    if continuation:
        cmd.extend(["--continuation-token", continuation])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)

    payload = json.loads(result.stdout or "{}")
    contents = payload.get("Contents", []) or []
    for entry in contents:
        key = entry.get("Key")
        if key:
            items.append(
                (
                    key,
                    entry.get("LastModified", ""),
                    int(entry.get("Size", 0) or 0),
                )
            )

    continuation = payload.get("NextContinuationToken")
    if not continuation:
        break

if not items:
    sys.exit(0)

items.sort(key=lambda row: row[1], reverse=True)

for key, last_modified, size in items[:max_snapshots]:
    sys.stdout.write(f"{key}\t{last_modified}\t{size}\n")
PY
)

if [ "${#snapshot_lines[@]}" -eq 0 ]; then
  error "No snapshots available in s3://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}"
  exit 1
fi

info "Available snapshots:"
SNAPSHOT_KEYS=()
SNAPSHOT_META=()
index=1
for line in "${snapshot_lines[@]}"; do
  [ -z "$line" ] && continue
  IFS=$'\t' read -r key last_modified size_bytes <<<"$line"
  [ -z "$key" ] && continue
  SNAPSHOT_KEYS+=("$key")
  human_date="$(date -u -d "$last_modified" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$last_modified")"
  size_kib=$(( (size_bytes + 1023) / 1024 ))
  SNAPSHOT_META+=("${human_date} UTC, ~${size_kib} KiB")
  printf '  %2d) %s (%s)\n' "$index" "$key" "${SNAPSHOT_META[-1]}"
  index=$((index + 1))
done

selection=""
while [ -z "$selection" ]; do
  read -r -p "Select a snapshot by number (or 'q' to quit): " selection
  if [ "$selection" = "q" ]; then
    info "Aborted by user"
    exit 0
  fi
  if ! [[ "$selection" =~ ^[0-9]+$ ]]; then
    warn "Please enter a valid number"
    selection=""
    continue
  fi
  if [ "$selection" -lt 1 ] || [ "$selection" -gt "${#SNAPSHOT_KEYS[@]}" ]; then
    warn "Selection out of range"
    selection=""
  fi
done

snapshot_key="${SNAPSHOT_KEYS[$((selection-1))]}"
snapshot_file="$(basename "$snapshot_key")"
info "Selected snapshot: $snapshot_key"

if [ "$DRY_RUN" = true ]; then
  info "Dry-run mode enabled: no resources will be created."
fi

if [ -z "$SSH_KEY" ] && [ "$DRY_RUN" = false ]; then
  read -r -p "Path to SSH private key for the new Redis instance: " SSH_KEY
fi

if [ -n "$SSH_KEY" ] && [ ! -f "$SSH_KEY" ]; then
  error "SSH key not found at $SSH_KEY"
  exit 1
fi

if [ -n "$SSH_KEY" ]; then
  chmod 600 "$SSH_KEY" >/dev/null 2>&1 || true
fi

instance_name="redis-restore-$(date -u '+%Y%m%d-%H%M%S')"
provisioned_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
tag_spec="ResourceType=instance,Tags=[{Key=Name,Value=${instance_name}},{Key=RedisProvisionedBy,Value=${TAG_PROVISIONED_BY}},{Key=RedisSnapshot,Value=${snapshot_file}},{Key=RedisProvisionedAt,Value=${provisioned_at}}]"

instance_id=""
if [ "$DRY_RUN" = true ]; then
  info "[dry-run] aws --profile $AWS_PROFILE --region $AWS_REGION ec2 run-instances --launch-template LaunchTemplateId=${LAUNCH_TEMPLATE_ID},Version=\$Latest --tag-specifications $tag_spec"
  instance_id="i-DRYRUN"
else
  instance_id=$("${AWS_BASE[@]}" ec2 run-instances     --launch-template "LaunchTemplateId=${LAUNCH_TEMPLATE_ID},Version=\$Latest"     --tag-specifications "$tag_spec"     --query 'Instances[0].InstanceId' --output text)
fi

if [ -z "$instance_id" ]; then
  error "Unable to determine instance ID"
  exit 1
fi

info "Instance ID: $instance_id"

if [ "$DRY_RUN" = false ]; then
  info "Waiting for instance to reach running state"
  "${AWS_BASE[@]}" ec2 wait instance-running --instance-ids "$instance_id"
fi

describe_instance() {
  "${AWS_BASE[@]}" ec2 describe-instances --instance-ids "$instance_id" --query 'Reservations[0].Instances[0]' --output json
}

instance_info=""
if [ "$DRY_RUN" = false ]; then
  instance_info=$(describe_instance)
fi

attached_groups=""
if [ "$DRY_RUN" = false ] && [ -n "$instance_info" ]; then
  attached_groups=$(printf '%s' "$instance_info" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(" ".join(g.get("GroupId") for g in data.get("SecurityGroups", [])))' 2>/dev/null || true)
fi

if [ "$DRY_RUN" = false ] && [ -n "$instance_info" ]; then
  if ! printf ' %s ' "$attached_groups" | grep -q " ${REQUIRED_SECURITY_GROUP} "; then
    info "Adding security group ${REQUIRED_SECURITY_GROUP}"
    all_groups="$attached_groups ${REQUIRED_SECURITY_GROUP}"
    all_groups=$(printf '%s' "$all_groups" | tr ' ' '\n' | awk 'NF' | sort -u | tr '\n' ' ')
    "${AWS_BASE[@]}" ec2 modify-instance-attribute --instance-id "$instance_id" --groups $all_groups
    instance_info=$(describe_instance)
  fi
fi

private_ip=""
public_ip=""
if [ "$DRY_RUN" = false ] && [ -n "$instance_info" ]; then
  private_ip=$(printf '%s' "$instance_info" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("PrivateIpAddress",""))' 2>/dev/null || true)
  public_ip=$(printf '%s' "$instance_info" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("PublicIpAddress",""))' 2>/dev/null || true)
fi

info "Private IP: ${private_ip:-N/A}"
info "Public IP: ${public_ip:-N/A}"

if [ "$DRY_RUN" = false ]; then
  if [ -z "$public_ip" ]; then
    error "Instance does not have a public IP. Configure network access before continuing."
    exit 1
  fi

  info "Waiting for SSH on ${public_ip}"
  ssh_ready=false
  for attempt in $(seq 1 30); do
    if ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$SSH_KEY"       "${SSH_USER}@${public_ip}" "echo ready" >/dev/null 2>&1; then
      ssh_ready=true
      break
    fi
    sleep 10
  done
  if [ "$ssh_ready" = false ]; then
    error "Unable to establish SSH connection to ${public_ip}"
    exit 1
  fi
fi

if [ "$DRY_RUN" = false ]; then
  if [ -z "${AWS_KEY:-}" ] && [ -z "${AWS_SECRET:-}" ]; then
    if confirm "Provide AWS credentials for the new instance (required if instance profile lacks S3 access)?"; then
      read -r -p "AWS access key ID: " AWS_KEY_INPUT
      read -r -s -p "AWS secret access key: " AWS_SECRET_INPUT
      echo
      AWS_KEY="$AWS_KEY_INPUT"
      AWS_SECRET="$AWS_SECRET_INPUT"
    fi
  fi

  info "Transferring provisioning scripts"
  SSH_KEY="$SSH_KEY" PUBLIC_IP="$public_ip" REMOTE_USER="$SSH_USER"     AWS_REGION="$AWS_REGION" AWS_KEY="${AWS_KEY:-}" AWS_SECRET="${AWS_SECRET:-}"     "$TRANSFER_SCRIPT"

  info "Restoring snapshot ${snapshot_file}"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$SSH_KEY"     "${SSH_USER}@${public_ip}" "sudo env DUMP_FILE='${snapshot_file}' /home/${SSH_USER}/scripts/restore-from-backup.sh"
fi

if [ "$DRY_RUN" = false ]; then
  info "Comparing Redis datasets via ${BLOT_HOST}"
  live_dbsize=$(ssh "$BLOT_HOST" "redis-cli dbsize" 2>/dev/null || echo "unknown")
  new_dbsize=$(ssh "$BLOT_HOST" "redis-cli -h ${private_ip} dbsize" 2>/dev/null || echo "unknown")
  live_keys=$(ssh "$BLOT_HOST" "redis-cli info keyspace | grep '^db0'" 2>/dev/null || echo "db0:keys=?")
  new_keys=$(ssh "$BLOT_HOST" "redis-cli -h ${private_ip} info keyspace | grep '^db0'" 2>/dev/null || echo "db0:keys=?")
  new_ping=$(ssh "$BLOT_HOST" "redis-cli -h ${private_ip} ping" 2>/dev/null || echo "(connection failed)")

  printf '\nRedis comparison:\n'
  printf '  Live DB size: %s\n' "$live_dbsize"
  printf '  New  DB size: %s\n' "$new_dbsize"
  printf '  Live key info: %s\n' "$live_keys"
  printf '  New  key info: %s\n' "$new_keys"
  printf '  New  ping: %s\n' "$new_ping"

  if confirm "Update BLOT_REDIS_HOST to ${private_ip}?"; then
    info "Updating BLOT_REDIS_HOST on ${BLOT_HOST}"
    ssh "$BLOT_HOST" "sudo /bin/bash -s" <<EOF_REMOTE
set -euo pipefail
env_file=/etc/blot/secrets.env
new_host="${private_ip}"
if [ -f "\$env_file" ]; then
  if grep -q "^BLOT_REDIS_HOST=" "\$env_file"; then
    sed -i.bak "s/^BLOT_REDIS_HOST=.*/BLOT_REDIS_HOST=\${new_host}/" "\$env_file"
  else
    printf '\nBLOT_REDIS_HOST=%s\n' "\${new_host}" >> "\$env_file"
  fi
else
  printf 'BLOT_REDIS_HOST=%s\n' "\${new_host}" | tee "\$env_file" >/dev/null
fi
EOF_REMOTE

    info "Restarting Blot Docker containers"
    ssh "$BLOT_HOST" "docker ps --format '{{.Names}}' | grep '^blot-container-' | xargs -r docker restart"

    # The proxy container has its own copy of the Redis host (/etc/blot/proxy.env,
    # rendered into nginx.conf by render-config when the container starts - see
    # proxy/entrypoint.sh). A `docker exec ... openresty -s reload` re-parses that
    # already-rendered config, so it would NOT pick up the new host; the container
    # has to be replaced, which is what proxy/deploy/blue-green.sh does. Detect it
    # the same way renew-wildcard-ssl.sh does.
    containers=$(ssh "$BLOT_HOST" "docker ps --format '{{.Names}}' | grep -E '^blot-proxy-(blue|green)\$'" || true)
    if [ -n "$containers" ]; then
      info "Updating PROXY_REDIS_HOST in /etc/blot/proxy.env"
      ssh "$BLOT_HOST" "sudo sed -i.bak 's/^PROXY_REDIS_HOST=.*/PROXY_REDIS_HOST=${private_ip}/' /etc/blot/proxy.env && grep -q '^PROXY_REDIS_HOST=${private_ip}\$' /etc/blot/proxy.env"
      proxy_image=$(ssh "$BLOT_HOST" "docker ps --format '{{.Names}} {{.Image}}' | grep -E '^blot-proxy-(blue|green) ' | head -1 | cut -d' ' -f2")
      if ssh "$BLOT_HOST" "[ -x ~/proxy-deploy/blue-green.sh ]"; then
        info "Replacing the proxy container with ${proxy_image} (new Redis host) via blue-green.sh"
        if ssh "$BLOT_HOST" "~/proxy-deploy/blue-green.sh '${proxy_image}'"; then
          info "Proxy container replaced"
        else
          # blue-green.sh takes its baseline (snapshot + cert_baseline) from the
          # OLD container, which is still pointed at the OLD Redis. Since this
          # script is usually run because the old Redis is gone or unhealthy,
          # that baseline step is a likely reason for the refusal above: rerunning
          # the exact same command will fail the same way. If it's the old Redis
          # that's unreachable (not some other problem), the operator can skip the
          # certificate comparison with PROXY_SKIP_CERT_SWEEP=1.
          warn "blue-green.sh failed. The proxy container still uses the old Redis host. Replace it by hand:"
          warn "  ssh ${BLOT_HOST} '~/proxy-deploy/blue-green.sh ${proxy_image}'"
          warn "If it refused because the OLD Redis (now replaced) is unreachable - e.g. \"cannot record the custom-domain certificates\" or \"not swapping\" - skip the certificate comparison instead:"
          warn "  ssh ${BLOT_HOST} 'PROXY_SKIP_CERT_SWEEP=1 ~/proxy-deploy/blue-green.sh ${proxy_image}'"
        fi
      else
        warn "~/proxy-deploy/blue-green.sh not found on ${BLOT_HOST}. The proxy container still uses the old Redis host. Replace it NOW:"
        warn "  ssh ${BLOT_HOST} '~/proxy-deploy/blue-green.sh ${proxy_image}'"
      fi
    elif ssh "$BLOT_HOST" "systemctl is-active --quiet openresty"; then
      info "Reloading OpenResty"
      ssh "$BLOT_HOST" "sudo openresty -t && sudo openresty -s reload"
    else
      warn "No proxy container and no active bare-metal OpenResty found on ${BLOT_HOST}. Nothing was reloaded - find and restart whatever is serving :80/:443."
    fi
  else
    info "Environment update skipped by operator"
  fi

  mkdir -p "$(dirname "$LOG_FILE")"
  {
    printf 'timestamp=%s\n' "$provisioned_at"
    printf 'instance_id=%s\n' "$instance_id"
    printf 'snapshot_key=%s\n' "$snapshot_key"
    printf 'private_ip=%s\n' "$private_ip"
    printf 'public_ip=%s\n' "$public_ip"
    printf '---\n'
  } >> "$LOG_FILE"
  info "Logged instance metadata to $LOG_FILE"
fi

info "Provisioning workflow complete"
