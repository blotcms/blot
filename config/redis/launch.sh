#!/bin/bash
# Usage: launch.sh --type <instance-type> --from latest|<backup-name>|replica:<host> [options]
#        launch.sh --list [--profile NAME] [--region NAME]
# Launches a new Redis EC2 instance from the launch template on the newest
# Amazon Linux 2023 arm64 AMI, waits for SSH, runs bootstrap.sh, then loads
# data: restore.sh from an S3 backup, or REPLICAOF a running Redis. For
# replica:<host>, give the primary's own private IP, never the floating IP:
# the replica would replicate from itself once cutover.sh moves the IP.
#
# UNTESTED: written without the AWS CLI available. Try it with --dry-run first
# and watch the first real run.
#
# Options:
#   --key PATH       SSH private key (or REDIS_SSH_KEY); needed to reach the new host
#   --user USER      SSH user (default ec2-user)
#   --port PORT      SSH port (default 22; the AMI/user-data decides)
#   --profile NAME   AWS CLI profile        --region NAME   (default us-west-2)
#   --tag KEY=VALUE  extra instance tag, repeatable
#   --drill          a throwaway (drill, rehearsal, DR test): named drill-redis-*,
#                    tagged BlotDrill=true, and /etc/blot-redis/drill is written
#                    before bootstrap so backup.sh never uploads from it, even
#                    after a cutover marks it active
#   --list           list the backups in S3 (with this machine's AWS credentials)
#   --dry-run        look up the AMI and print the launch command, nothing more
# The host reaches S3 with an instance profile from the launch template or keys
# in ~/.aws (you are prompted to add them before the restore step).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

LAUNCH_TEMPLATE=lt-09f38dac82c204d58
SECURITY_GROUP=sg-0b3b200323d36ce2e
AMI_PARAMETER=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
TYPE=""; FROM=""; DRY_RUN=""; DRILL=""; LIST=""
KEY=${REDIS_SSH_KEY:-}; SSH_USER=ec2-user; SSH_PORT=22
AWS_REGION=${AWS_REGION:-us-west-2}; AWS_PROFILE_ARGS=""; EXTRA_TAGS=""

while [ $# -gt 0 ]; do
  case "$1" in --dry-run | --drill | --list) ;; *) [ $# -ge 2 ] || die "$1 needs a value" ;; esac
  case "$1" in
    --type) TYPE=$2; shift 2 ;;
    --from) FROM=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    --user) SSH_USER=$2; shift 2 ;;
    --port) SSH_PORT=$2; shift 2 ;;
    --profile) AWS_PROFILE_ARGS="--profile $2"; shift 2 ;;
    --region) AWS_REGION=$2; shift 2 ;;
    --tag)
      case "$2" in [A-Za-z]*=*) ;; *) die "--tag needs KEY=VALUE" ;; esac
      EXTRA_TAGS="$EXTRA_TAGS,{Key=${2%%=*},Value=${2#*=}}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --drill) DRILL=1; shift ;;
    --list) LIST=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
# shellcheck disable=SC2086
aws_cli() { aws $AWS_PROFILE_ARGS --region "$AWS_REGION" "$@"; }

if [ -n "$LIST" ]; then
  aws_cli s3 ls --recursive s3://blot-redis-backups/ | grep -E ' (hourly|daily)/.*\.rdb$' | sort
  exit 0
fi

[ -n "$TYPE" ] && [ -n "$FROM" ] || die "usage: launch.sh --type <instance-type> --from latest|<backup-name>|replica:<host>"
[ -n "$KEY" ] || [ -n "$DRY_RUN" ] || die "need --key (or REDIS_SSH_KEY): the private key for the instance"
[ -z "$KEY" ] || [ -f "$KEY" ] || die "no such key file: $KEY"

AMI=$(aws_cli ssm get-parameter --name "$AMI_PARAMETER" --query Parameter.Value --output text)
echo "AMI: $AMI"

NAME="redis-$(date -u +%Y%m%d-%H%M%S)"
[ -z "$DRILL" ] || { NAME="drill-$NAME"; EXTRA_TAGS="$EXTRA_TAGS,{Key=BlotDrill,Value=true}"; }
TAGS="ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=RedisProvisionedBy,Value=config/redis/launch.sh},{Key=RedisSource,Value=$FROM},{Key=RedisProvisionedAt,Value=$(date -u +%Y-%m-%dT%H:%M:%SZ)}$EXTRA_TAGS]"
if [ -n "$DRY_RUN" ]; then
  echo "would run: aws ec2 run-instances --launch-template LaunchTemplateId=$LAUNCH_TEMPLATE,Version=\$Latest --instance-type $TYPE --image-id $AMI --tag-specifications '$TAGS'"
  exit 0
fi

ID=$(aws_cli ec2 run-instances --launch-template "LaunchTemplateId=$LAUNCH_TEMPLATE,Version=\$Latest" \
  --instance-type "$TYPE" --image-id "$AMI" --tag-specifications "$TAGS" \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $ID ($NAME)"
aws_cli ec2 wait instance-running --instance-ids "$ID"

# The launch template may not attach our security group; Redis is only
# reachable (and only safe) with it.
GROUPS_NOW=$(aws_cli ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
case " $GROUPS_NOW " in
  *" $SECURITY_GROUP "*) ;;
  *)
    echo "Adding security group $SECURITY_GROUP"
    # shellcheck disable=SC2086
    aws_cli ec2 modify-instance-attribute --instance-id "$ID" --groups $GROUPS_NOW $SECURITY_GROUP ;;
esac

# Prefer the public address (you are on a laptop); fall back to the private one.
IP=$(aws_cli ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,PrivateIpAddress]' --output text | awk '{ if ($1 != "None") print $1; else print $2 }')
echo "Address: $IP"

# A new instance reuses IPs, so do not trust or record its host key.
export SSH_OPTS="-i $KEY -p $SSH_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
TARGET="$SSH_USER@$IP"

echo "Waiting for SSH"
for _ in $(seq 1 30); do ssh_run "$TARGET" true 2> /dev/null && break; sleep 10; done
ssh_run "$TARGET" true || die "cannot ssh to $TARGET; the instance $ID is still running"

if [ -n "$DRILL" ]; then
  ssh_run "$TARGET" "sudo mkdir -p /etc/blot-redis && sudo touch /etc/blot-redis/drill" ||
    die "could not mark $TARGET as a drill host; the instance $ID is still running"
  echo "Marked as a drill host: backup.sh will never upload from it"
fi

"$HERE/bootstrap.sh" "$TARGET"

case "$FROM" in
  replica:*)
    PRIMARY=${FROM#replica:}
    # A full sync of several GB under write load overflows 6.2's default
    # replica output buffer on the primary (256mb, or 64mb for 60s), which
    # drops the replica and starts the sync over, again and again. Raise it to
    # redis.conf's value first, from the new host (Redis has no auth).
    echo "client-output-buffer-limit on $PRIMARY was: $(ssh_run "$TARGET" "redis6-cli -h $PRIMARY CONFIG GET client-output-buffer-limit | tail -n 1")"
    ssh_run "$TARGET" "redis6-cli -h $PRIMARY CONFIG SET client-output-buffer-limit 'replica 1073741824 536870912 120' | grep -qx OK" ||
      die "could not raise client-output-buffer-limit on $PRIMARY"
    echo "Replicating from $PRIMARY"
    ssh_run "$TARGET" "redis6-cli REPLICAOF $PRIMARY 6379 | grep -qx OK" || die "REPLICAOF failed"
    echo "Waiting for the first sync (watch master_link_status on $TARGET)"
    for _ in $(seq 1 720); do
      status=$(ssh_run "$TARGET" "redis6-cli INFO replication | tr -d '\r'")
      echo "$status" | grep -qx 'master_link_status:up' && break
      sleep 10
    done
    echo "$status" | grep -qx 'master_link_status:up' || die "replica did not sync within two hours; $TARGET is still replicating"
    echo "Replica is in sync." ;;
  *)
    until ssh_run "$TARGET" "aws s3 ls s3://blot-redis-backups/ > /dev/null 2>&1"; do
      echo "$TARGET cannot read the backup bucket yet. Attach an instance profile or run 'aws configure' there:"
      echo "  ssh $SSH_OPTS $TARGET"
      read -r -p "Press Enter to retry, Ctrl-C to stop (the instance keeps running): " _
    done
    "$HERE/restore.sh" --yes "$TARGET" "$FROM" ;;
esac

echo "Done: $ID ($NAME) at $IP"
