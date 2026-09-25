#!/usr/bin/env bash
set -euo pipefail

# Restores a single blog's data/blogs/<blog_id> folder from a past EBS
# snapshot and downloads it to your machine.
#
# How it works:
#   1. Resolves the identifier you enter (URL, handle, blog id, user id...)
#      to an actual blog_id the same way `npm run download-folder` does,
#      via `scripts/info` on the live blot host.
#   2. Lists the available DLM snapshots of the production data volume and
#      lets you pick one by number.
#   3. Creates a new EBS volume from that snapshot (the LIVE volume/prod
#      data is never touched - this is entirely read-only as far as
#      production is concerned).
#   4. Launches a throwaway t3.micro instance, attaches the restored volume
#      to it read-only, tars up just the one blog folder, and scp's it to
#      your machine.
#   5. Tears everything it created back down (volume, instance, temporary
#      SSH key pair, temporary security group).
#
# NOTE: the production data volume's DLM policy only keeps 7 daily
# snapshots, so at most ~7 dates will be offered.
#
# Requires: aws CLI (configured/authenticated), ssh access to the `blot`
# host (for identifier resolution), python3.

DEFAULT_REGION="us-west-2"
DEFAULT_INSTANCE_TYPE="t3.micro"
DEFAULT_BLOT_HOST="blot"
DEFAULT_DOWNLOAD_DIR="$HOME/Downloads"

AWS_PROFILE=${AWS_PROFILE:-default}
AWS_REGION=${AWS_REGION:-$DEFAULT_REGION}
INSTANCE_TYPE=${INSTANCE_TYPE:-$DEFAULT_INSTANCE_TYPE}
BLOT_HOST=${BLOT_HOST:-$DEFAULT_BLOT_HOST}
DOWNLOAD_DIR=${DOWNLOAD_DIR:-$DEFAULT_DOWNLOAD_DIR}
SSH_USER=${SSH_USER:-ec2-user}

RUN_ID="restore-folder-$(date -u +%Y%m%d%H%M%S)-$$"
LOG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/restore-folder-instances.log"

AWS_BASE=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
error() { printf '[ERROR] %s\n' "$*" >&2; }

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Required command '$1' not found in PATH"
    exit 1
  fi
}

require_command aws
require_command ssh
require_command scp
require_command python3
require_command tar

if [ -z "${DATA_VOLUME_ID:-}" ]; then
  read -r -p "Enter the EBS volume ID for the production data volume: " DATA_VOLUME_ID
fi
[ -z "$DATA_VOLUME_ID" ] && { error "No volume ID entered"; exit 1; }

# ---------------------------------------------------------------------------
# Look up the volume's size and current (live) attachment - this tells us
# its AZ/subnet/VPC (so we never hardcode networking details) and gives us
# what we need for the cost/time estimate and the permission preflight
# below, all before anything gets created.
# ---------------------------------------------------------------------------
read -r VOLUME_SIZE_GB AZ SOURCE_INSTANCE_ID <<<"$("${AWS_BASE[@]}" ec2 describe-volumes --volume-ids "$DATA_VOLUME_ID" \
  --query 'Volumes[0].[Size,AvailabilityZone,Attachments[0].InstanceId]' --output text)"

if [ -z "$VOLUME_SIZE_GB" ] || [ "$VOLUME_SIZE_GB" = "None" ]; then
  error "Could not determine the size of volume $DATA_VOLUME_ID"
  exit 1
fi

if [ -z "$SOURCE_INSTANCE_ID" ] || [ "$SOURCE_INSTANCE_ID" = "None" ]; then
  error "Volume $DATA_VOLUME_ID is not currently attached to any instance - can't auto-discover networking"
  exit 1
fi

read -r SUBNET_ID VPC_ID <<<"$(${AWS_BASE[@]} ec2 describe-instances --instance-ids "$SOURCE_INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].[SubnetId,VpcId]' --output text)"

info "AZ=$AZ Subnet=$SUBNET_ID VPC=$VPC_ID (derived from live instance $SOURCE_INSTANCE_ID)"

AMI_ID=$("${AWS_BASE[@]}" ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

# ---------------------------------------------------------------------------
# Permission preflight: dry-run every mutating EC2 call this script needs,
# before creating anything. --dry-run performs the IAM authorization check
# only and never creates a resource - AWS returns "DryRunOperation" if
# you're allowed, "UnauthorizedOperation" if you're not.
# ---------------------------------------------------------------------------
PREFLIGHT_OK=true

check_permission() {
  local label="$1"
  shift
  local output
  output=$("${AWS_BASE[@]}" "$@" --dry-run 2>&1) || true
  if echo "$output" | grep -q "DryRunOperation"; then
    info "  ok: $label"
  elif echo "$output" | grep -q "UnauthorizedOperation"; then
    error "  missing permission: $label"
    PREFLIGHT_OK=false
  else
    error "  could not verify: $label -> $output"
    PREFLIGHT_OK=false
  fi
}

info "Checking required AWS permissions..."
check_permission "ec2:CreateVolume" ec2 create-volume \
  --availability-zone "$AZ" --size 1 --volume-type gp3
check_permission "ec2:CreateKeyPair" ec2 create-key-pair \
  --key-name "${RUN_ID}-preflight"
check_permission "ec2:CreateSecurityGroup" ec2 create-security-group \
  --group-name "${RUN_ID}-preflight" --description "preflight check" --vpc-id "$VPC_ID"
check_permission "ec2:RunInstances" ec2 run-instances \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" --subnet-id "$SUBNET_ID"

if [ "$PREFLIGHT_OK" != true ]; then
  error "Missing one or more required AWS permissions - aborting before creating anything."
  exit 1
fi

# Note: ec2:AttachVolume, ec2:AuthorizeSecurityGroupIngress, and the
# terminate/delete permissions used during cleanup can't be dry-run checked
# here since they need real resource IDs that don't exist yet. They're
# normally granted alongside the create/run permissions above, but if one
# of them is missing it will surface later in the run - the cleanup trap
# still does its best to tear down whatever was created.

# ---------------------------------------------------------------------------
# Estimate cost/time before touching anything, and get the operator to
# confirm.
# ---------------------------------------------------------------------------
GP3_RATE_PER_GB_MONTH="0.08"
INSTANCE_RATE_PER_HOUR="0.0104"
EST_LOW_MINUTES="5"
EST_HIGH_MINUTES="15"

read -r EST_LOW_COST EST_HIGH_COST <<<"$(python3 - \
  "$VOLUME_SIZE_GB" "$GP3_RATE_PER_GB_MONTH" "$INSTANCE_RATE_PER_HOUR" "$EST_LOW_MINUTES" "$EST_HIGH_MINUTES" <<'PY'
import sys

size_gb, gp3_rate, instance_rate, low_min, high_min = (float(x) for x in sys.argv[1:])


def cost(minutes):
    hours = minutes / 60
    volume_cost = size_gb * gp3_rate / 730 * hours
    instance_cost = instance_rate * hours
    return volume_cost + instance_cost


print(f"{cost(low_min):.2f} {cost(high_min):.2f}")
PY
)"

info "Volume $DATA_VOLUME_ID is ${VOLUME_SIZE_GB}GB."
info "Estimated time: ${EST_LOW_MINUTES}-${EST_HIGH_MINUTES} min (instance boot/teardown dominate; the tar/scp step depends on the individual blog folder's size, not the full volume)."
info "Estimated cost: \$${EST_LOW_COST}-\$${EST_HIGH_COST} (gp3 volume + t3.micro instance, prorated for the run duration; excludes data transfer for the downloaded folder)."

read -r -p "Proceed? [y/N] " CONFIRM
case "$CONFIRM" in
  y | Y | yes | YES) ;;
  *)
    info "Aborted - nothing was created."
    exit 0
    ;;
esac

# ---------------------------------------------------------------------------
# Cleanup: every AWS resource we create is torn down here, best-effort, no
# matter how the script exits. IDs are logged as soon as they're known so a
# failed cleanup can still be finished by hand.
# ---------------------------------------------------------------------------
NEW_VOLUME_ID=""
INSTANCE_ID=""
SG_ID=""
KEY_NAME=""
KEY_FILE=""
ATTACHED=false

log_resource() { printf '[%s] %s=%s\n' "$RUN_ID" "$1" "$2" >>"$LOG_FILE"; }

cleanup() {
  local status=$?
  info "Cleaning up temporary resources for $RUN_ID..."

  if [ -n "$INSTANCE_ID" ]; then
    if [ "$ATTACHED" = true ] && [ -n "$NEW_VOLUME_ID" ]; then
      "${AWS_BASE[@]}" ec2 detach-volume --volume-id "$NEW_VOLUME_ID" --force >/dev/null 2>&1 || true
      "${AWS_BASE[@]}" ec2 wait volume-available --volume-ids "$NEW_VOLUME_ID" >/dev/null 2>&1 || true
    fi
    "${AWS_BASE[@]}" ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 || true
    "${AWS_BASE[@]}" ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 || true
    info "Terminated instance $INSTANCE_ID"
  fi

  if [ -n "$NEW_VOLUME_ID" ]; then
    "${AWS_BASE[@]}" ec2 delete-volume --volume-id "$NEW_VOLUME_ID" >/dev/null 2>&1 \
      && info "Deleted restored volume $NEW_VOLUME_ID" \
      || warn "Could not delete volume $NEW_VOLUME_ID - check the console"
  fi

  if [ -n "$SG_ID" ]; then
    "${AWS_BASE[@]}" ec2 delete-security-group --group-id "$SG_ID" >/dev/null 2>&1 \
      && info "Deleted temporary security group $SG_ID" \
      || warn "Could not delete security group $SG_ID - check the console"
  fi

  if [ -n "$KEY_NAME" ]; then
    "${AWS_BASE[@]}" ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1 || true
    [ -n "$KEY_FILE" ] && rm -f "$KEY_FILE"
    info "Deleted temporary key pair $KEY_NAME"
  fi

  exit "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Resolve the blog identifier to its actual data/blogs/<blog_id> folder
#    name, the same way `npm run download-folder` does.
# ---------------------------------------------------------------------------
read -r -p "Enter blog identifier (URL, handle, or blog id): " IDENTIFIER
[ -z "$IDENTIFIER" ] && { error "No identifier entered"; exit 1; }

info "Resolving '$IDENTIFIER' to a blog_id via $BLOT_HOST..."
BLOG_ID=$(ssh "$BLOT_HOST" "docker exec blot-container-blue node /usr/src/app/scripts/info \"$IDENTIFIER\"" | grep 'blog_' | head -n1 | cut -d ' ' -f 2 || true)

if [ -z "$BLOG_ID" ]; then
  error "Could not resolve '$IDENTIFIER' to a blog_id"
  exit 1
fi
info "Resolved to blog_id: $BLOG_ID"

# ---------------------------------------------------------------------------
# 2. List the available daily snapshots and let the operator pick one.
# ---------------------------------------------------------------------------
info "Listing snapshots for volume $DATA_VOLUME_ID..."
SNAPSHOT_JSON=$("${AWS_BASE[@]}" ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=volume-id,Values=$DATA_VOLUME_ID" \
  --query 'Snapshots[].{Id:SnapshotId,Start:StartTime,State:State}' \
  --output json)

SNAPSHOT_LIST=$(python3 - "$SNAPSHOT_JSON" <<'PY'
import json
import sys
from datetime import datetime, timezone

snapshots = json.loads(sys.argv[1])
completed = [s for s in snapshots if s.get("State") == "completed"]
if not completed:
    sys.exit(1)

for s in completed:
    s["_start"] = datetime.fromisoformat(s["Start"].replace("Z", "+00:00"))

completed.sort(key=lambda s: s["_start"], reverse=True)

now = datetime.now(timezone.utc)
for s in completed:
    age_days = (now - s["_start"]).days
    ago = "today" if age_days == 0 else f"{age_days} day{'s' if age_days != 1 else ''} ago"
    print(f"{s['Id']}\t{s['_start'].strftime('%Y-%m-%d %H:%M UTC')}\t{ago}")
PY
) || { error "No completed snapshots found for volume $DATA_VOLUME_ID"; exit 1; }

info "Available backups:"
SNAPSHOT_IDS=()
SNAPSHOT_DATES=()
index=1
while IFS=$'\t' read -r snap_id snap_date snap_ago; do
  [ -z "$snap_id" ] && continue
  SNAPSHOT_IDS+=("$snap_id")
  SNAPSHOT_DATES+=("$snap_date")
  printf '  [%d] %s (%s)\n' "$index" "$snap_date" "$snap_ago"
  index=$((index + 1))
done <<<"$SNAPSHOT_LIST"

selection=""
while [ -z "$selection" ]; do
  read -r -p "Select backup by number: " selection
  if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -gt "${#SNAPSHOT_IDS[@]}" ]; then
    warn "Please enter a number between 1 and ${#SNAPSHOT_IDS[@]}"
    selection=""
  fi
done

SNAPSHOT_ID="${SNAPSHOT_IDS[$((selection-1))]}"
TARGET_DATE=$(cut -d' ' -f1 <<<"${SNAPSHOT_DATES[$((selection-1))]}")
info "Selected snapshot: $SNAPSHOT_ID ($TARGET_DATE)"

# ---------------------------------------------------------------------------
# 3. Create the restored volume from the chosen snapshot (AZ/subnet/VPC/AMI
#    were already discovered above, before the permission preflight).
# ---------------------------------------------------------------------------
info "Creating volume from snapshot $SNAPSHOT_ID in $AZ..."
NEW_VOLUME_ID=$("${AWS_BASE[@]}" ec2 create-volume \
  --snapshot-id "$SNAPSHOT_ID" \
  --availability-zone "$AZ" \
  --volume-type gp3 \
  --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=${RUN_ID}},{Key=RestoreFolderRun,Value=${RUN_ID}}]" \
  --query 'VolumeId' --output text)
log_resource volume_id "$NEW_VOLUME_ID"
info "Created volume $NEW_VOLUME_ID"
"${AWS_BASE[@]}" ec2 wait volume-available --volume-ids "$NEW_VOLUME_ID"

# ---------------------------------------------------------------------------
# 4. Temporary key pair + security group (SSH from this machine's IP only).
# ---------------------------------------------------------------------------
MY_IP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
[ -z "$MY_IP" ] && { error "Could not determine your public IP"; exit 1; }
info "Allowing SSH from ${MY_IP}/32 only"

KEY_NAME="$RUN_ID"
KEY_FILE="$(mktemp -d)/${KEY_NAME}.pem"
"${AWS_BASE[@]}" ec2 create-key-pair --key-name "$KEY_NAME" --query 'KeyMaterial' --output text >"$KEY_FILE"
chmod 600 "$KEY_FILE"
log_resource key_name "$KEY_NAME"

SG_ID=$("${AWS_BASE[@]}" ec2 create-security-group \
  --group-name "$RUN_ID" \
  --description "Temporary SG for restore-folder.sh ($RUN_ID)" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text)
log_resource sg_id "$SG_ID"
"${AWS_BASE[@]}" ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 22 --cidr "${MY_IP}/32" >/dev/null

# ---------------------------------------------------------------------------
# 5. Launch the cheapest instance that can mount the volume and scp the data
#    off (a stock Amazon Linux 2023 box - no Blot app image needed).
# ---------------------------------------------------------------------------
info "Launching $INSTANCE_TYPE ($AMI_ID) in $SUBNET_ID..."

INSTANCE_ID=$("${AWS_BASE[@]}" ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --subnet-id "$SUBNET_ID" \
  --security-group-ids "$SG_ID" \
  --associate-public-ip-address \
  --placement "AvailabilityZone=$AZ" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${RUN_ID}}]" \
  --instance-initiated-shutdown-behavior terminate \
  --query 'Instances[0].InstanceId' --output text)
log_resource instance_id "$INSTANCE_ID"
info "Instance: $INSTANCE_ID"

"${AWS_BASE[@]}" ec2 wait instance-running --instance-ids "$INSTANCE_ID"
PUBLIC_IP=$("${AWS_BASE[@]}" ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" = "None" ]; then
  error "Instance has no public IP - subnet $SUBNET_ID may not auto-assign one"
  exit 1
fi

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$KEY_FILE")

info "Waiting for SSH on $PUBLIC_IP..."
ssh_ready=false
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "echo ready" >/dev/null 2>&1; then
    ssh_ready=true
    break
  fi
  sleep 10
done
[ "$ssh_ready" = true ] || { error "Could not SSH into $PUBLIC_IP"; exit 1; }

# ---------------------------------------------------------------------------
# 6. Attach the restored volume, find its device name, mount read-only.
# ---------------------------------------------------------------------------
BEFORE_DISKS=$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "lsblk -ndo NAME")

info "Attaching $NEW_VOLUME_ID to $INSTANCE_ID..."
"${AWS_BASE[@]}" ec2 attach-volume --volume-id "$NEW_VOLUME_ID" --instance-id "$INSTANCE_ID" --device /dev/sdf >/dev/null
"${AWS_BASE[@]}" ec2 wait volume-in-use --volume-ids "$NEW_VOLUME_ID"
ATTACHED=true

NEW_DEVICE=""
for _ in $(seq 1 15); do
  AFTER_DISKS=$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "lsblk -ndo NAME")
  NEW_DEVICE=$(comm -13 <(echo "$BEFORE_DISKS" | sort) <(echo "$AFTER_DISKS" | sort) | head -n1)
  [ -n "$NEW_DEVICE" ] && break
  sleep 2
done
[ -n "$NEW_DEVICE" ] || { error "Could not find the newly attached device on the instance"; exit 1; }
info "New device: /dev/$NEW_DEVICE"

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "sudo mkdir -p /mnt/restore && sudo mount -o ro /dev/${NEW_DEVICE} /mnt/restore"

REMOTE_BLOG_PATH="/mnt/restore/blogs/${BLOG_ID}"
if ! ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "[ -d '$REMOTE_BLOG_PATH' ]"; then
  error "$REMOTE_BLOG_PATH does not exist on the restored volume"
  exit 1
fi

# ---------------------------------------------------------------------------
# 7. Tar it up on the instance and scp it down.
# ---------------------------------------------------------------------------
ARCHIVE_NAME="${BLOG_ID}-${TARGET_DATE}.tar.gz"
info "Archiving $REMOTE_BLOG_PATH..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "sudo tar czf /tmp/${ARCHIVE_NAME} -C /mnt/restore/blogs ${BLOG_ID} && sudo chown ${SSH_USER} /tmp/${ARCHIVE_NAME}"

mkdir -p "$DOWNLOAD_DIR"
info "Downloading to ${DOWNLOAD_DIR}/${ARCHIVE_NAME}..."
scp "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}:/tmp/${ARCHIVE_NAME}" "$DOWNLOAD_DIR/"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "rm -f /tmp/${ARCHIVE_NAME}"

info "Extracting locally..."
tar xzf "$DOWNLOAD_DIR/$ARCHIVE_NAME" -C "$DOWNLOAD_DIR"
command -v open >/dev/null 2>&1 && open "$DOWNLOAD_DIR/$BLOG_ID"

info "Done. Folder restored to $DOWNLOAD_DIR/$BLOG_ID (and archive at $DOWNLOAD_DIR/$ARCHIVE_NAME)"
# cleanup trap runs automatically from here
