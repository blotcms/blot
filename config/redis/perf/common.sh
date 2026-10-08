# shellcheck shell=bash
# Helpers shared by the operator-side scripts in this directory (sourced, not
# run). They run on a Mac, so this has to work in bash 3.2. Builds on ../lib.sh
# (ssh_run, die, SSH_OPTS).

PERF_DIR_LOCAL=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib.sh
. "$PERF_DIR_LOCAL/../lib.sh"

# app_ssh <host> [command...]: ssh_run for the app host. It is usually reached
# on a different port than the Redis host, so APP_SSH_OPTS, when set, replaces
# SSH_OPTS for it (an ssh-config alias works for both without either).
app_ssh() {
  SSH_OPTS=${APP_SSH_OPTS-${SSH_OPTS:-}} ssh_run "$@"
}
