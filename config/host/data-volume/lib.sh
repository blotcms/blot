# Helpers shared by resize.sh and drill.sh (sourced, not run). They run on a
# Mac, so this has to work in bash 3.2: no associative arrays, no ${var,,}, and
# no "${array[@]}" of an empty array under set -u.
#
# These are copied from config/redis/lib.sh rather than sourced: that file sets
# HERE for itself and its push_files() only knows about the Redis scripts.
#
# SSH_OPTS: extra ssh options as one string, e.g. SSH_OPTS="-i $HOME/key.pem -p 22"
# (or put them in ~/.ssh/config and pass the host alias).
# AWS_PROFILE_NAME and AWS_REGION: set by the caller before aws_cli is used.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

# ssh_run <host> [command...]: ssh with batch-mode defaults.
ssh_run() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}

aws_cli() { aws --profile "$AWS_PROFILE_NAME" --region "$AWS_REGION" "$@"; }

# field <text> <key>: the value from a "key=value" line.
field() { echo "$1" | awk -v k="$2" '{i = index($0, "=")} i && substr($0, 1, i - 1) == k {print substr($0, i + 1); exit}'; }

# fmt_duration <seconds>: 3725 -> 1h02m05s
fmt_duration() {
  local s=$1
  if [ "$s" -ge 3600 ]; then
    printf '%dh%02dm%02ds' $((s / 3600)) $((s % 3600 / 60)) $((s % 60))
  elif [ "$s" -ge 60 ]; then
    printf '%dm%02ds' $((s / 60)) $((s % 60))
  else
    printf '%ds' "$s"
  fi
}

# gib <bytes>: whole GiB, rounded down.
gib() { echo $(($1 / 1073741824)); }

# push_host_script <host>: copy host.sh to /tmp/blot-data-volume/host.sh on the
# host. Done with tar over ssh because scp is unreliable here: ec2-user's
# ~/.bashrc cds to /var/www/blot, and it prints into the scp session.
push_host_script() {
  # COPYFILE_DISABLE stops macOS tar adding ._ files and extended attributes.
  COPYFILE_DISABLE=1 tar -C "$HERE" -cf - host.sh |
    ssh_run "$1" 'rm -rf /tmp/blot-data-volume && mkdir /tmp/blot-data-volume && tar -xf - -C /tmp/blot-data-volume'
}
