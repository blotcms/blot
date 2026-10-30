#!/bin/bash
# Usage: launch.sh --type <instance-type> --key-name <aws-key-pair> [options]
#        launch.sh --list [--profile NAME] [--region NAME]
# Launches a new app host on the newest Amazon Linux 2023 arm64 AMI, waits for
# SSH and runs bootstrap.sh on it, which also installs and configures Redis and
# firewalls port 6379. It then checks from here that 6379 is not reachable on
# the host's public address (nc). The last lines print the deploy.sh command
# to run next. It attaches no data volume, moves no Elastic IP and sets up no
# replication.
# Runs on a Mac, so it has to work in bash 3.2.
#
# Try it with --dry-run first.
#
# Options:
#   --type TYPE            instance type (required)
#   --key-name NAME        the AWS key pair (required; or BLOT_HOST_KEY_NAME)
#   --redis-maxmemory VALUE  Redis's maxmemory, e.g. 10gb (or REDIS_MAXMEMORY); required
#                          except with --dry-run. No default: it depends on the unit sizes
#   --key PATH             SSH private key (or BLOT_HOST_SSH_KEY); needed to reach the new host
#   --ssh-port N           the port sshd listens on (or BLOT_SSH_PORT). Set in user data, so
#                          the first connection already uses it: the security group may not
#                          allow 22. Passed on to bootstrap.sh
#   --deploy-public-key FILE  the deploy user's ssh public key (or BLOT_DEPLOY_PUBLIC_KEY,
#                          holding the key itself); passed on to bootstrap.sh
#   --root-gb N            root volume size in GB, gp3 (default 200: the Redis RDB and a spare copy)
#   --instance-profile NAME  IAM instance profile (default none)
#   --user USER            SSH user (default ec2-user)
#   --profile NAME         AWS CLI profile        --region NAME   (default us-west-2)
#   --tag KEY=VALUE        extra instance tag, repeatable
#   --drill                a throwaway: named drill-app-*, tagged BlotDrill=true, and
#                          termination protection is not set
#   --list                 list the app hosts this script launched
#   --dry-run              look up the AMI and print the launch command, nothing more
# Real hosts get termination protection at launch.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "error: $*" >&2; exit 1; }

ssh_run() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}

AMI_PARAMETER=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
# A volume can only attach in its own AZ: this is the subnet (us-west-2a) the data volume and both current hosts are in.
SUBNET=subnet-4a78973d
APP_SECURITY_GROUP=sg-0d1c2c28e0c7084ad
REDIS_SECURITY_GROUP=sg-0b3b200323d36ce2e
PROVISIONED_BY=config/host/launch.sh

TYPE=""; KEY_NAME=${BLOT_HOST_KEY_NAME:-}; KEY=${BLOT_HOST_SSH_KEY:-}; REDIS_MAXMEMORY=${REDIS_MAXMEMORY:-}
SSH_PORT=${BLOT_SSH_PORT:-}; DEPLOY_KEY=${BLOT_DEPLOY_PUBLIC_KEY:-}
ROOT_GB=200; INSTANCE_PROFILE=""; SSH_USER=ec2-user
DRY_RUN=""; DRILL=""; LIST=""
AWS_REGION=${AWS_REGION:-us-west-2}; AWS_PROFILE_ARGS=""; EXTRA_TAGS=""

while [ $# -gt 0 ]; do
  case "$1" in --dry-run | --drill | --list) ;; *) [ $# -ge 2 ] || die "$1 needs a value" ;; esac
  case "$1" in
    --type) TYPE=$2; shift 2 ;;
    --key-name) KEY_NAME=$2; shift 2 ;;
    --redis-maxmemory) REDIS_MAXMEMORY=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    --ssh-port) SSH_PORT=$2; shift 2 ;;
    --deploy-public-key)
      [ -f "$2" ] || die "no such file: $2"
      DEPLOY_KEY=$(cat "$2"); shift 2 ;;
    --root-gb) ROOT_GB=$2; shift 2 ;;
    --instance-profile) INSTANCE_PROFILE=$2; shift 2 ;;
    --user) SSH_USER=$2; shift 2 ;;
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
  aws_cli ec2 describe-instances --filters "Name=tag:HostProvisionedBy,Values=$PROVISIONED_BY" \
    --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`]|[0].Value,InstanceType,State.Name,PrivateIpAddress]' --output text | sort -k2
  exit 0
fi

[ -n "$TYPE" ] || die "usage: launch.sh --type <instance-type> --key-name <aws-key-pair> [options]"
[ -n "$KEY_NAME" ] || die "need --key-name (or BLOT_HOST_KEY_NAME): the AWS key pair"
[ -n "$KEY" ] || [ -n "$DRY_RUN" ] || die "need --key (or BLOT_HOST_SSH_KEY): the private key for the instance"
[ -n "$REDIS_MAXMEMORY" ] || [ -n "$DRY_RUN" ] || die "need --redis-maxmemory (or REDIS_MAXMEMORY), e.g. 10gb"
[ -n "$DRY_RUN" ] || command -v nc > /dev/null || die "need nc, to check that Redis is not reachable from outside"
[ -z "$KEY" ] || [ -f "$KEY" ] || die "no such key file: $KEY"
[ -z "$SSH_PORT" ] || [[ $SSH_PORT =~ ^[0-9]+$ ]] || die "--ssh-port takes a port number"
[[ $ROOT_GB =~ ^[0-9]+$ ]] || die "--root-gb takes a number"

AMI=$(aws_cli ssm get-parameter --name "$AMI_PARAMETER" --query Parameter.Value --output text)
echo "AMI: $AMI"
ROOT_DEVICE=$(aws_cli ec2 describe-images --image-ids "$AMI" --query 'Images[0].RootDeviceName' --output text)
MAPPINGS='[{"DeviceName":"'"$ROOT_DEVICE"'","Ebs":{"VolumeSize":'"$ROOT_GB"',"VolumeType":"gp3","DeleteOnTermination":true}}]'

NAME="app-$(date -u +%Y%m%d-%H%M%S)"
[ -z "$DRILL" ] || { NAME="drill-$NAME"; EXTRA_TAGS="$EXTRA_TAGS,{Key=BlotDrill,Value=true}"; }
TAGS="{Key=Name,Value=$NAME},{Key=HostProvisionedBy,Value=$PROVISIONED_BY},{Key=HostProvisionedAt,Value=$(date -u +%Y-%m-%dT%H:%M:%SZ)}$EXTRA_TAGS"

# With --ssh-port, user data moves sshd before boot finishes, so the first
# connection already uses it. The file is the one host/setup.sh writes, so
# setup.sh sees no change.
USERDATA=""
if [ -n "$SSH_PORT" ]; then
  USERDATA=$(printf '#!/bin/bash\nmkdir -p /etc/ssh/sshd_config.d\nprintf "# Installed by config/host/host/setup.sh.\\nPort %s\\n" > /etc/ssh/sshd_config.d/11-blot-port.conf\nchmod 0600 /etc/ssh/sshd_config.d/11-blot-port.conf\nsystemctl restart sshd\n' "$SSH_PORT")
fi

# Termination protection is set at launch, so there is no window without it.
# The root volume gets the same tags as the instance.
ARGS=(ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY_NAME"
  --subnet-id "$SUBNET" --security-group-ids "$APP_SECURITY_GROUP" "$REDIS_SECURITY_GROUP"
  --block-device-mappings "$MAPPINGS"
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1
  --tag-specifications "ResourceType=instance,Tags=[$TAGS]" "ResourceType=volume,Tags=[$TAGS]")
[ -n "$DRILL" ] || ARGS+=(--disable-api-termination)
[ -z "$INSTANCE_PROFILE" ] || ARGS+=(--iam-instance-profile "Name=$INSTANCE_PROFILE")
[ -z "$USERDATA" ] || ARGS+=(--user-data "$USERDATA")

if [ -n "$DRY_RUN" ]; then
  [ -z "$USERDATA" ] || printf 'user data:\n%s\n' "$USERDATA"
  printf 'would run: aws %s --region %s' "$AWS_PROFILE_ARGS" "$AWS_REGION"
  printf ' %q' "${ARGS[@]}"
  echo
  exit 0
fi

ID=$(aws_cli "${ARGS[@]}" --query 'Instances[0].InstanceId' --output text)
echo "Instance: $ID ($NAME)"
aws_cli ec2 wait instance-running --instance-ids "$ID"

# Prefer the public address (you are on a laptop); fall back to the private one.
ADDRESSES=$(aws_cli ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,PrivateIpAddress]' --output text)
PUBLIC_ADDRESS=$(echo "$ADDRESSES" | awk '$1 != "None" { print $1 }')
IP=$(echo "$ADDRESSES" | awk '{ if ($1 != "None") print $1; else print $2 }')
echo "Address: $IP"

# A new instance reuses IPs, so do not trust or record its host key.
export SSH_OPTS="-i $KEY -p ${SSH_PORT:-22} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
TARGET="$SSH_USER@$IP"

echo "Waiting for SSH"
for _ in $(seq 1 30); do ssh_run "$TARGET" true 2> /dev/null && break; sleep 10; done
ssh_run "$TARGET" true || die "cannot ssh to $TARGET; the instance $ID is still running"

REDIS_MAXMEMORY=$REDIS_MAXMEMORY BLOT_SSH_PORT=$SSH_PORT BLOT_DEPLOY_PUBLIC_KEY=$DEPLOY_KEY "$HERE/bootstrap.sh" "$TARGET" ||
  die "bootstrap.sh failed; the instance $ID is still running"

# Redis has no password: the security group and the host firewall are the only
# protection. This catches both being wrong. Meaningless against a private address.
if [ -n "$PUBLIC_ADDRESS" ]; then
  if nc -z -w 5 "$PUBLIC_ADDRESS" 6379 > /dev/null 2>&1; then
    die "REDIS IS EXPOSED: $PUBLIC_ADDRESS accepts connections on port 6379, and Redis has no password. Fix the security group and the firewall now. The instance $ID is still running"
  fi
  echo "Port 6379 is not reachable on $PUBLIC_ADDRESS"
else
  echo "No public address: port 6379 was not checked from outside"
fi

echo "Done: $ID ($NAME) at $IP"
# Not `npm run deploy-host`: it sources the production host's PUBLIC_IP over these.
echo "Next: SSH_KEY=<your key> PUBLIC_IP=$IP SSH_PORT=${SSH_PORT:-22} config/host/deploy.sh"
echo "Run it again with DATA_VOLUME_ID=<vol-...> once the data volume is attached."
