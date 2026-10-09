#!/bin/bash
# Usage: drill.sh launch --ami ID --subnet ID --security-group ID --key-name NAME [options]
#        drill.sh setup [--key PATH] <ssh-target>
#        drill.sh teardown [--yes] <instance-id>
# Rehearses resize.sh on a throwaway instance with the same kernel and
# userland as the app host, and a small copy of its layout, without touching
# production: an 8 GiB XFS data volume mounted by mount-data-volume.sh, the
# top-level directories filled with about 50,000 small files, two
# "app" containers (one reading, one writing) that bind the data directory
# with rslave, and a proxy container that binds only data/static.
#
#   launch     t4g.small, tagged Name=drill-data-volume and BlotDrill=true, with
#              the data volume attached at /dev/sdf (tagged BlotDrill=true).
#              Copy the values from the app host:
#                aws ec2 describe-instances --instance-ids <app host id> \
#                  --query 'Reservations[0].Instances[0].[ImageId,SubnetId,SecurityGroups[0].GroupId,KeyName]'
#              (an Amazon Linux 2 arm64 AMI, so the kernel matches production)
#   setup      install docker, rsync and xfsprogs, format the data volume,
#              install mount-data-volume.sh from the data-volume-mount branch,
#              fill it, start the containers; then print the resize.sh commands
#   teardown   terminate the instance and delete its volumes and the snapshots
#              the drill made, each by explicit ID, each only after its
#              BlotDrill=true tag is checked again
#
# Options:
#   --profile NAME   AWS CLI profile (default blot)    --region NAME (default us-west-2)
#   --key PATH       SSH private key (setup; or DRILL_SSH_KEY)
#   --yes            do not ask for confirmation (teardown)
#   --dry-run        launch and teardown print what they would do and change nothing
set -euo pipefail
. "$(dirname "$0")/lib.sh"

AWS_PROFILE_NAME=blot
AWS_REGION=${AWS_REGION:-us-west-2}
AMI=""; SUBNET=""; SECURITY_GROUP=""; KEY_NAME=""
KEY=${DRILL_SSH_KEY:-}
YES=""; DRY_RUN=""; CMD=""; ARG=""
MOUNT_BRANCH=origin/claude/data-volume-mount
REPO=$(cd "$HERE/../../.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --ami | --subnet | --security-group | --key-name | --key | --profile | --region) [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --ami) AMI=$2; shift 2 ;;
    --subnet) SUBNET=$2; shift 2 ;;
    --security-group) SECURITY_GROUP=$2; shift 2 ;;
    --key-name) KEY_NAME=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    --profile) AWS_PROFILE_NAME=$2; shift 2 ;;
    --region) AWS_REGION=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option $1" ;;
    *)
      if [ -z "$CMD" ]; then CMD=$1
      elif [ -z "$ARG" ]; then ARG=$1
      else die "unexpected argument $1"; fi
      shift ;;
  esac
done

confirm() {
  [ -z "$YES" ] || return 0
  local reply
  read -r -p "$1 Type yes: " reply || die "no answer (use --yes when not running interactively)"
  [ "$reply" = yes ] || die "aborted"
}

# tag <volume-or-instance-or-snapshot id> <key>: the value of a tag ("None" if absent).
volume_tag() { aws_cli ec2 describe-volumes --volume-ids "$1" --query 'Volumes[0].Tags[?Key==`'"$2"'`].Value | [0]' --output text; }

cmd_launch() {
  [ -n "$AMI" ] && [ -n "$SUBNET" ] && [ -n "$SECURITY_GROUP" ] && [ -n "$KEY_NAME" ] ||
    die "launch needs --ami, --subnet, --security-group and --key-name (nothing is hardcoded; see the comments at the top of this file)"
  local tags='{"Key":"BlotDrill","Value":"true"},{"Key":"Name","Value":"drill-data-volume"}'
  # The volume tag specification applies to every volume made at launch, the
  # root volume included; the root goes away with the instance.
  local specs='[{"ResourceType":"instance","Tags":['"$tags"']},{"ResourceType":"volume","Tags":['"$tags"']}]'
  # DeleteOnTermination is false for the data volume so that teardown, not
  # termination, is what deletes it, by ID and after checking the tag.
  local mappings='[{"DeviceName":"/dev/sdf","Ebs":{"VolumeSize":8,"VolumeType":"gp3","DeleteOnTermination":false}}]'
  if [ -n "$DRY_RUN" ]; then
    echo "would run: aws --profile $AWS_PROFILE_NAME --region $AWS_REGION ec2 run-instances --image-id $AMI --instance-type t4g.small --subnet-id $SUBNET --security-group-ids $SECURITY_GROUP --key-name $KEY_NAME --block-device-mappings '$mappings' --tag-specifications '$specs'"
    return 0
  fi
  local id ip
  id=$(aws_cli ec2 run-instances --image-id "$AMI" --instance-type t4g.small --subnet-id "$SUBNET" \
    --security-group-ids "$SECURITY_GROUP" --key-name "$KEY_NAME" \
    --block-device-mappings "$mappings" --tag-specifications "$specs" \
    --query 'Instances[0].InstanceId' --output text)
  echo "Instance: $id"
  aws_cli ec2 wait instance-running --instance-ids "$id"
  ip=$(aws_cli ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].[PublicIpAddress,PrivateIpAddress]' --output text |
    awk '{ if ($1 != "None") print $1; else print $2 }')
  echo "Address:  $ip"
  echo
  echo "Next: $0 --profile $AWS_PROFILE_NAME --region $AWS_REGION --key <your .pem> setup ec2-user@$ip"
  echo "Afterwards: $0 --profile $AWS_PROFILE_NAME --region $AWS_REGION teardown $id"
}

# repo_file <path in the repo> <destination>: from the working tree if it is
# there (once the data-volume-mount branch is merged), else from that branch
# in the local clone. Vendoring copies here would go stale; this needs the
# branch fetched (git fetch origin) until it is merged.
repo_file() {
  if [ -f "$REPO/$1" ]; then cp "$REPO/$1" "$2"
  else git -C "$REPO" show "$MOUNT_BRANCH:$1" > "$2" 2> /dev/null ||
    die "$1 is neither in this checkout nor on $MOUNT_BRANCH: git fetch origin, or merge the data-volume-mount branch first"; fi
}

# The root-side half of setup, run on the drill host with VOLUME_ID set.
remote_setup() {
  cat << 'EOF'
set -euo pipefail
DATA=/var/www/blot/data
LINK=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUME_ID/-/}

command -v docker > /dev/null || amazon-linux-extras install -y docker
for p in rsync xfsprogs lsof; do rpm -q "$p" > /dev/null || yum install -y "$p"; done
systemctl enable --now docker
usermod -aG docker ec2-user || true

for _ in $(seq 1 60); do [ -e "$LINK" ] && break; sleep 1; done
[ -e "$LINK" ] || { echo "$LINK did not appear"; exit 1; }
mkdir -p /etc/blot "$DATA"
if ! mountpoint -q "$DATA"; then
  [ -n "$(blkid -p -o value -s TYPE "$LINK" || true)" ] || mkfs.xfs -L blotdata "$LINK"
  mount -t xfs -o noatime "$LINK" "$DATA"
  echo "$VOLUME_ID" > "$DATA/.blot-data-volume"
  umount "$DATA"
fi
echo "$VOLUME_ID" > /etc/blot/data-volume
touch /etc/blot/drill

chmod 755 /home/ec2-user/scripts/mount-data-volume.sh
cp /home/ec2-user/scripts/mount-data-volume.service /etc/systemd/system/mount-data-volume.service
systemctl daemon-reload
systemctl enable --now mount-data-volume.service
mountpoint -q "$DATA"
findmnt -n -o PROPAGATION --target "$DATA" | grep -qx shared

# Something to copy: about 50,000 small files in the production layout, a
# hard link, a symlink and a sparse file so that -H and -S have work to do.
if [ ! -d "$DATA/static" ]; then
  mkdir -p "$DATA"/{static,blogs,git,logs,tmp,views,cdn} "$DATA/blogs/drill"
  for i in $(seq 1 20); do
    mkdir -p "$DATA/static/$i/img" "$DATA/blogs/$i/entries" "$DATA/git/$i/objects"
    for j in $(seq 1 1000); do
      echo "static $i $j" > "$DATA/static/$i/img/f$j.txt"
      echo "entry $i $j" > "$DATA/blogs/$i/entries/e$j.txt"
    done
    for j in $(seq 1 250); do echo "object $i $j" > "$DATA/git/$i/objects/o$j"; done
  done
  for j in $(seq 1 1000); do echo "scratch $j" > "$DATA/tmp/t$j"; done
  echo "cert log" > "$DATA/logs/expiring-certs.log"
  ln "$DATA/static/1/img/f1.txt" "$DATA/static/1/img/hardlink.txt"
  ln -s img/f2.txt "$DATA/static/1/link.txt"
  truncate -s 64M "$DATA/git/sparse.pack"
fi

# Two "app" containers bind the whole data directory with rslave, like
# scripts/deploy/util/generateDockerCommand.js; the proxy binds only static,
# with a plain -v, like the real proxy. The names matter: host.sh looks for
# blot-container-*.
D=/usr/src/app/data
for n in blot-container-blue blot-container-green blot-proxy-drill; do docker rm -f "$n" > /dev/null 2>&1 || true; done
docker run -d --name blot-container-blue --restart unless-stopped \
  --mount type=bind,source="$DATA",target="$D",bind-propagation=rslave alpine \
  sh -c 'while true; do for f in static/1/img/f1.txt blogs/1/entries/e1.txt blogs/2/entries/e2.txt .blot-data-volume; do cat /usr/src/app/data/$f > /dev/null 2>&1 || echo "$(date +%T) cannot read $f"; done; sleep 0.2; done'
docker run -d --name blot-container-green --restart unless-stopped \
  --mount type=bind,source="$DATA",target="$D",bind-propagation=rslave alpine \
  sh -c 'while true; do cat /usr/src/app/data/static/3/img/f3.txt > /dev/null 2>&1 || echo "$(date +%T) cannot read"; echo "$(date +%s)" >> /usr/src/app/data/blogs/drill/writes.log || echo "$(date +%T) write failed"; sleep 0.2; done'
docker run -d --name blot-proxy-drill --restart unless-stopped \
  -v "$DATA/static:/data/static:ro" alpine \
  sh -c 'while true; do cat /data/static/1/img/f1.txt > /dev/null 2>&1 || echo "$(date +%T) proxy cannot read"; sleep 1; done'
docker ps --format '{{.Names}}'
df -i "$DATA"
EOF
}

cmd_setup() {
  [ -n "$ARG" ] || die "usage: drill.sh setup [--key PATH] <ssh-target>"
  local target=$ARG instance vol i
  SSH_OPTS="${KEY:+-i $KEY }-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  [ -z "$KEY" ] || [ -f "$KEY" ] || die "no such key file: $KEY"
  work=$(mktemp -d) # global: the EXIT trap uses it
  trap 'rm -rf "$work"' EXIT
  repo_file config/host/scripts/mount-data-volume.sh "$work/mount-data-volume.sh"
  repo_file config/host/scripts/mount-data-volume.service "$work/mount-data-volume.service"
  chmod 755 "$work/mount-data-volume.sh"

  say "Waiting for SSH to $target"
  for i in $(seq 1 30); do ssh_run "$target" true 2> /dev/null && break; sleep 10; done
  ssh_run "$target" true || die "cannot ssh to $target"

  say "Finding the data volume"
  instance=$(ssh_run "$target" 'T=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60"); curl -sf -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/instance-id')
  vol=$(aws_cli ec2 describe-instances --instance-ids "$instance" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName==`/dev/sdf`].Ebs.VolumeId | [0]' --output text)
  [[ "$vol" =~ ^vol-[0-9a-f]{8,17}$ ]] || die "$instance has no volume at /dev/sdf ('$vol')"
  [ "$(volume_tag "$vol" BlotDrill)" = true ] || die "$vol is not tagged BlotDrill=true; refusing to format it"
  echo "$instance, data volume $vol"

  say "Installing mount-data-volume and setting the host up"
  COPYFILE_DISABLE=1 tar -C "$work" -cf - mount-data-volume.sh mount-data-volume.service |
    ssh_run "$target" 'mkdir -p /home/ec2-user/scripts && tar -xf - -C /home/ec2-user/scripts'
  remote_setup | ssh_run "$target" "sudo env VOLUME_ID=$vol bash -s"

  say "Ready"
  cat << EOF
Rehearse from the repo root (the key, if any, goes in SSH_OPTS):
  export SSH_OPTS="${SSH_OPTS}"
  P="--profile $AWS_PROFILE_NAME --region $AWS_REGION"
  config/host/data-volume/resize.sh \$P --host $target --dry-run shrink 6
  config/host/data-volume/resize.sh \$P --host $target --any-time shrink 6
  config/host/data-volume/resize.sh \$P --host $target grow 10
Watch while it runs: ssh $target docker logs -f blot-container-blue (read errors),
and blot-container-green (the writer; its writes.log is in data/blogs/drill).
After the shrink the proxy keeps serving the old volume until it is recreated
(docker rm -f blot-proxy-drill and run it again), like the real proxy.
Clean up: $0 --profile $AWS_PROFILE_NAME --region $AWS_REGION teardown $instance
EOF
}

cmd_teardown() {
  [[ "$ARG" =~ ^i-[0-9a-f]{8,17}$ ]] || die "usage: drill.sh teardown <instance-id>"
  local id=$ARG state flag vols found snaps v s out
  # Re-described right before anything is deleted: the tag, not the ID the
  # operator typed, decides what is a drill.
  flag=$(aws_cli ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].Tags[?Key==`BlotDrill`].Value | [0]' --output text)
  [ "$flag" = true ] || die "$id is not tagged BlotDrill=true; refusing"
  state=$(aws_cli ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' --output text)
  [ "$state" != terminated ] || die "$id is already terminated; its volumes can no longer be tied to it, delete any leftovers by hand"
  vols=$(aws_cli ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' --output text | tr '\t' ' ')
  # Volumes the resize made from this instance's volumes: they are not in the
  # instance's mappings once it is gone, or never were if the shrink was
  # interrupted before the attach.
  found=""; snaps=""
  for v in $vols; do
    found="$found $(aws_cli ec2 describe-volumes --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$v" --query 'Volumes[].VolumeId' --output text | tr '\t' ' ')"
    snaps="$snaps $(aws_cli ec2 describe-snapshots --owner-ids self --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$v" --query 'Snapshots[].SnapshotId' --output text | tr '\t' ' ')"
  done
  # A second generation (a grow after a shrink does not make one, a second shrink does).
  for v in $found; do
    found="$found $(aws_cli ec2 describe-volumes --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$v" --query 'Volumes[].VolumeId' --output text | tr '\t' ' ')"
    snaps="$snaps $(aws_cli ec2 describe-snapshots --owner-ids self --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$v" --query 'Snapshots[].SnapshotId' --output text | tr '\t' ' ')"
  done
  vols=$(echo "$vols $found" | tr ' ' '\n' | grep . | sort -u | tr '\n' ' ')
  snaps=$(echo "$snaps" | tr ' ' '\n' | grep . | sort -u | tr '\n' ' ')
  say "Teardown plan"
  echo "Terminate $id ($state)"
  echo "Delete volumes (each only if still tagged BlotDrill=true): ${vols:-none}"
  echo "Delete snapshots (same check): ${snaps:-none}"
  if [ -n "$DRY_RUN" ]; then echo; echo "Dry run: nothing changed."; return 0; fi
  confirm "Terminate the drill instance and delete these?"

  aws_cli ec2 terminate-instances --instance-ids "$id" > /dev/null
  aws_cli ec2 wait instance-terminated --instance-ids "$id"
  for v in $vols; do
    out=$(aws_cli ec2 describe-volumes --volume-ids "$v" --query 'Volumes[0].[State,Tags[?Key==`BlotDrill`].Value|[0]]' --output text 2>&1) || {
      case "$out" in *NotFound*) echo "$v is already gone"; continue ;; esac
      die "cannot describe $v: $out"
    }
    case "$out" in
      *true) ;;
      *) echo "WARNING: $v is not tagged BlotDrill=true any more; leaving it"; continue ;;
    esac
    aws_cli ec2 wait volume-available --volume-ids "$v"
    aws_cli ec2 delete-volume --volume-id "$v"
    echo "Deleted $v"
  done
  for s in $snaps; do
    out=$(aws_cli ec2 describe-snapshots --snapshot-ids "$s" --query 'Snapshots[0].Tags[?Key==`BlotDrill`].Value | [0]' --output text 2>&1) || {
      case "$out" in *NotFound*) echo "$s is already gone"; continue ;; esac
      die "cannot describe $s: $out"
    }
    [ "$out" = true ] || { echo "WARNING: $s is not tagged BlotDrill=true; leaving it"; continue; }
    aws_cli ec2 delete-snapshot --snapshot-id "$s"
    echo "Deleted $s"
  done
}

case "$CMD" in
  launch) cmd_launch ;;
  setup) cmd_setup ;;
  teardown) cmd_teardown ;;
  *) die "usage: drill.sh launch|setup <ssh-target>|teardown <instance-id>" ;;
esac
