#!/bin/bash
# Usage: bans.sh export <ssh-host> <file>
#        bans.sh import <ssh-host> <file>
# Moves the manual-permaban jail's bans between hosts, or restores them after a
# restart dropped them. The file has one IPv4/IPv6 address or CIDR per line.
# Keep it in the gitignored data/ directory of the main checkout (worktrees have
# none), never in the repo: the list of banned ranges is not public. This script
# prints counts only, so the addresses stay out of logs and CI.
#
# export  writes the sorted, unique union of what the jail bans now and the
#         rows in fail2ban's database with bantime -1, which are still there
#         after a restart dropped the ban. Needs sqlite3 on the host. A failed
#         export leaves an older file as it was.
# import  checks every line first and refuses the whole file if one is bad,
#         bans what is not banned yet, then checks each one is listed and exits
#         non-zero if not.
#
# Works without a tty or .bashrc, so cycle.sh can call it. Runs on a Mac, so it
# has to work in bash 3.2.
#
# Env: SSH_OPTS  extra ssh options as one string, e.g.
#                SSH_OPTS="-i $HOME/key.pem -p 22"
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

ssh_run() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}

[ $# -eq 3 ] || die "usage: bans.sh export|import <ssh-host> <file>"
CMD=$1
HOST=$2
FILE=$3

TMP=$(mktemp "${TMPDIR:-/tmp}/bans.XXXXXX")
trap 'rm -f "$TMP" "$TMP.out"' EXIT

# valid <address-or-cidr>: IPv4 or IPv6, with an optional prefix length.
valid() {
  local ip=${1%%/*} mask= o
  case "$1" in */*) mask=${1#*/} ;; esac
  if [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    for o in "${BASH_REMATCH[@]:1}"; do [ "$((10#$o))" -le 255 ] || return 1; done
    [ -z "$mask" ] || { [[ $mask =~ ^[0-9]{1,2}$ ]] && [ "$((10#$mask))" -le 32 ]; }
  elif [[ $ip =~ ^[0-9A-Fa-f:]{2,39}$ && $ip == *:*:* && $ip != *:::* ]]; then
    [ -z "$mask" ] || { [[ $mask =~ ^[0-9]{1,3}$ ]] && [ "$((10#$mask))" -le 128 ]; }
  else
    return 1
  fi
}

# Run on the host. The jail's list is a python list, so strip it to one per line.
REMOTE_COMMON='set -o pipefail
JAIL=manual-permaban
DB=/var/lib/fail2ban/fail2ban.sqlite3
banned() { sudo fail2ban-client get $JAIL banned | tr -d "[]'"'"',"  | tr " " "\n" | { grep . || true; } | sort -u; }'

case "$CMD" in
export)
  ssh_run "$HOST" "$REMOTE_COMMON
    command -v sqlite3 > /dev/null || { echo 'sqlite3 is not installed on the host' >&2; exit 3; }
    { sudo sqlite3 \$DB \"select ip from bips where jail = '\$JAIL' and bantime = -1\" && banned; } | sort -u" > "$TMP.out" ||
    die "could not read the bans from $HOST"
  grep -E '^[0-9A-Fa-f:.]+(/[0-9]+)?$' "$TMP.out" | sort -u > "$TMP" || true
  mv "$TMP" "$FILE"
  echo "Exported $(grep -c . "$FILE" || true) bans to $FILE"
  ;;
import)
  [ -f "$FILE" ] || die "no such file: $FILE"
  tr -d '[:blank:]\r' < "$FILE" | grep . | sort -u > "$TMP" || true
  bad=0
  while read -r line; do valid "$line" || bad=$((bad + 1)); done < "$TMP"
  [ "$bad" = 0 ] || die "$FILE has $bad invalid line(s). Nothing was banned."
  # The list goes over stdin; only counts come back. It is validated, so the
  # remote shell can split it safely.
  ssh_run "$HOST" "$REMOTE_COMMON
    list=\$(cat); had=\$(banned); added=0; skipped=0; missing=0
    for ip in \$list; do
      if echo \"\$had\" | grep -Fxq \"\$ip\"; then skipped=\$((skipped + 1)); continue; fi
      sudo fail2ban-client set \$JAIL banip \"\$ip\" > /dev/null 2>&1 && added=\$((added + 1))
    done
    now=\$(banned)
    for ip in \$list; do echo \"\$now\" | grep -Fxq \"\$ip\" || missing=\$((missing + 1)); done
    echo \"added \$added, already banned \$skipped, missing \$missing\"
    [ \$missing = 0 ]" < "$TMP" > "$TMP.out" || {
    cat "$TMP.out"
    die "not every ban is listed on $HOST afterwards"
  }
  echo "$(grep -c . "$TMP" || true) in $FILE: $(cat "$TMP.out")"
  ;;
*) die "usage: bans.sh export|import <ssh-host> <file>" ;;
esac
