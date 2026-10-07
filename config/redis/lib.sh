# Helpers shared by the operator-side scripts (sourced, not run). They run on
# a Mac, so this has to work in bash 3.2.
#
# SSH_OPTS: extra ssh options as one string, e.g. SSH_OPTS="-i $HOME/key.pem -p 22"
# (or put them in ~/.ssh/config and pass the host alias).

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "error: $*" >&2; exit 1; }

# ssh_run <host> [command...]: ssh with batch-mode defaults.
ssh_run() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}

# push_files <host>: copy redis.conf, bin/ and host/ to /tmp/blot-redis on the host.
push_files() {
  # COPYFILE_DISABLE stops macOS tar adding ._ files and extended attributes.
  COPYFILE_DISABLE=1 tar -C "$HERE" -cf - redis.conf bin host |
    ssh_run "$1" 'rm -rf /tmp/blot-redis && mkdir /tmp/blot-redis && tar -xf - -C /tmp/blot-redis'
}
