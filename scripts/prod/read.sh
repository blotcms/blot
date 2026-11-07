#!/usr/bin/env bash
set -euo pipefail

# Read-only views of the production host, over `ssh blot`. Every subcommand runs a
# fixed remote command that changes nothing, so this one script can be allowlisted
# for agents while every other production command still needs the maintainer's OK.
# Arguments are validated here, and grep patterns travel over stdin rather than in
# the remote command line, so no argument can add a command on the host. Filter the
# output locally (grep, awk, node) rather than with remote pipes.
#
#   scripts/prod/read.sh ps                         unit containers, status, created
#   scripts/prod/read.sh inspect <unit>             OOMKilled, exit code, start time, restarts, memory limit
#   scripts/prod/read.sh stats                      docker stats, one sample
#   scripts/prod/read.sh app-log [unit] [opts]      app.log: both units' output, kept across deploys
#                                                   (14 days), each line tagged <container>/<commit>
#   scripts/prod/read.sh logs <unit> [opts]         a unit's container logs, with timestamps (only
#                                                   since its last deploy: prefer app-log)
#   scripts/prod/read.sh access [opts]              openresty access log
#   scripts/prod/read.sh error-log [opts]           openresty error log
#   scripts/prod/read.sh log-files                  list the log directory, with rotated days
#   scripts/prod/read.sh release                    the release (commit) each unit runs
#   scripts/prod/read.sh health-check-log [opts]    restarts made by the health-check script
#   scripts/prod/read.sh node-reports <unit>        newest Node diagnostic reports for a unit
#   scripts/prod/read.sh host                       uptime, disk, memory, overcommit
#   scripts/prod/read.sh dmesg-oom                  kernel OOM kills
#   scripts/prod/read.sh tcpmem                     socket memory against tcp_mem, and its 5-minute log
#   scripts/prod/read.sh cron-logs [lines]          tails of the Redis host's cron logs, and the cron file
#   scripts/prod/read.sh backups                    the backup disk, its mount and service, and the backup log
#   scripts/prod/read.sh redis-info [section]       redis6-cli INFO (server, clients, memory, ...)
#   scripts/prod/read.sh redis-config <param>       redis6-cli CONFIG GET for a known parameter
#   scripts/prod/read.sh redis-memory-conf          /etc/redis6/blot-memory.conf
#   scripts/prod/read.sh redis-role                 replication role and the active marker
#   scripts/prod/read.sh redis-slowlog [count]      redis6-cli SLOWLOG GET
#   scripts/prod/read.sh redis-clients              client connections per address
#   scripts/prod/read.sh redis-log [opts]           Redis's own log
#   scripts/prod/read.sh redis-journal [hours]      journalctl for the redis6 unit
#   scripts/prod/read.sh fail2ban <jail>            a fail2ban jail's status
#   scripts/prod/read.sh errors <unit|app-log|error-log> [--since <window>] [--top <n>]
#                                                   error and warning lines collapsed into
#                                                   templates (ids, URLs, numbers stripped),
#                                                   most frequent first: count, template, one example
#
# Options for app-log, logs, access, error-log, health-check-log and redis-log:
#   --since <30m|6h|2d|ISO time>   app-log and logs only: start of the window
#   --tail <n>                     last n lines (after --grep)
#   --grep <text>                  keep lines containing the text (fixed string)
#   --yesterday                    access only: yesterday's requests too (the file rotated today)
#   --day <YYYYMMDD>               access and app-log only: just the file rotated on that date,
#                                  which holds the previous day's lines (gzipped or not)
#   --rotated                      error-log only: include the rotated (and gzipped) files
#
# Writes nothing on the host. Anything else (scripts in a container, docker cp,
# redis writes) is a normal production command and needs the maintainer's OK.

LOG_DIRECTORY=/var/instance-ssd/logs
UNITS="blue green"
REDIS_SECTIONS="server clients memory persistence stats replication cpu errorstats keyspace commandstats"
REDIS_PARAMS="maxmemory maxmemory-policy maxclients min-replicas-to-write save tracking-table-max-keys appendonly"

usage() {
  sed -n '/^#   scripts/p; /^# Options/,/^#$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

fail() {
  echo "read.sh: $*" >&2
  exit 2
}

one_of() {
  local value="$1" list="$2" item
  for item in $list; do [[ "$value" == "$item" ]] && return 0; done
  return 1
}

number() {
  [[ "$1" =~ ^[0-9]{1,6}$ ]] || fail "expected a number, got '$1'"
}

unit_name() {
  one_of "${1:-}" "$UNITS" || fail "unit must be one of: $UNITS"
  echo "blot-$1"
}

remote() {
  ssh -n -o BatchMode=yes blot "$1"
}

# Like remote, but passes this script's stdin to the remote command
remote_stdin() {
  ssh -o BatchMode=yes blot "$1"
}

# Parses --since/--tail/--grep/--yesterday into SINCE, TAIL, PATTERN and YESTERDAY
parse_options() {
  SINCE="" TAIL="" PATTERN="" YESTERDAY="" DAY="" ROTATED=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since)
        [[ "${2:-}" =~ ^([0-9]{1,4}[smhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?)$ ]] || fail "bad --since '${2:-}'"
        SINCE="$2"
        # docker logs takes Go durations, which have no day unit
        [[ "$SINCE" =~ ^([0-9]+)d$ ]] && SINCE="$((BASH_REMATCH[1] * 24))h"
        shift 2 ;;
      --tail) number "${2:-}"; TAIL="$2"; shift 2 ;;
      --grep) [[ -n "${2:-}" ]] || fail "--grep needs text"; PATTERN="$2"; shift 2 ;;
      --yesterday) YESTERDAY=1; shift ;;
      --day)
        [[ "${2:-}" =~ ^20[0-9]{6}$ ]] || fail "bad --day '${2:-}' (YYYYMMDD)"
        DAY="$2"; shift 2 ;;
      --rotated) ROTATED=1; shift ;;
      *) fail "unknown option '$1'" ;;
    esac
  done
}

# Runs a remote command that prints lines, applying PATTERN and TAIL on the host
# so large logs don't cross the network. The pattern is read from stdin.
filtered() {
  local command="$1" filters=""
  if [[ -n "$PATTERN" ]]; then
    filters=" | grep -F -e \"\$pattern\""
  fi
  if [[ -n "$TAIL" ]]; then
    filters="$filters | tail -n $TAIL"
  fi
  printf '%s' "$PATTERN" | remote_stdin "pattern=\$(cat); { $command; }$filters"
}

# The remote command that prints app.log from SINCE (as parse_options leaves it)
# on: every file, rotated or not, written to since then, oldest first, and of
# those only the lines from then on. Lines start with an RFC 3339 time, so a
# string comparison does. With no SINCE, today's file.
app_log_since() {
  local when
  if [[ -z "$SINCE" ]]; then
    echo "cat $LOG_DIRECTORY/app.log"
    return
  fi
  if [[ "$SINCE" =~ ^([0-9]+)([smh])$ ]]; then
    case "${BASH_REMATCH[2]}" in s) when="${BASH_REMATCH[1]} seconds ago" ;; m) when="${BASH_REMATCH[1]} minutes ago" ;; h) when="${BASH_REMATCH[1]} hours ago" ;; esac
  else
    when="$SINCE"
  fi
  echo "e=\$(date -u -d '$when' +%s); c=\$(date -u -d @\$e +%Y-%m-%dT%H:%M:%S); find $LOG_DIRECTORY -maxdepth 1 -name 'app.log*' -newermt @\$e -printf '%T@ %p\\n' | sort -n | cut -d' ' -f2 | while read -r f; do zcat -f \$f; done | awk -v c=\$c '\$1 >= c'"
}

[[ $# -ge 1 ]] || usage
command="$1"; shift

case "$command" in
  ps)
    remote "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Image}}'" ;;
  inspect)
    name=$(unit_name "${1:-}")
    remote "docker inspect $name --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}} Memory={{.HostConfig.Memory}}'" ;;
  stats)
    remote "docker stats --no-stream" ;;
  logs)
    name=$(unit_name "${1:-}"); shift
    parse_options "$@"
    [[ -z "$YESTERDAY$DAY$ROTATED" ]] || fail "logs takes only --since, --grep and --tail"
    since=""
    [[ -n "$SINCE" ]] && since="--since $SINCE"
    filtered "docker logs --timestamps $since $name 2>&1" ;;
  app-log)
    tag=""
    if [[ -n "${1:-}" && "$1" != -* ]]; then tag="$(unit_name "$1")/"; shift; fi
    parse_options "$@"
    [[ -z "$YESTERDAY$ROTATED" ]] || fail "app-log takes --since, --day, --grep and --tail"
    [[ -z "$DAY" || -z "$SINCE" ]] || fail "use --day or --since, not both"
    if [[ -n "$DAY" ]]; then
      input="f=$LOG_DIRECTORY/app.log-$DAY; [ -e \$f ] || f=\$f.gz; zcat -f \$f"
    else
      input="$(app_log_since)"
    fi
    # The tag is the second field: blot-blue/<commit>
    [[ -z "$tag" ]] || input="$input | awk -v t=$tag 'index(\$2, t) == 1'"
    filtered "$input" ;;
  access)
    parse_options "$@"
    [[ -z "$SINCE$ROTATED" ]] || fail "access takes --grep, --tail, --yesterday and --day"
    [[ -z "$DAY" || -z "$YESTERDAY" ]] || fail "use --day or --yesterday, not both"
    # logrotate names each file for the day it rotated (holding the day before's
    # requests) and gzips it a day later, so read whichever of the two exists
    rotated="rotated() { f=$LOG_DIRECTORY/access.log-\$1; [ -e \$f ] || f=\$f.gz; zcat -f \$f; }"
    if [[ -n "$DAY" ]]; then
      filtered "$rotated; rotated $DAY"
    elif [[ -n "$YESTERDAY" ]]; then
      filtered "$rotated; rotated \$(date +%Y%m%d); cat $LOG_DIRECTORY/access.log"
    else
      filtered "cat $LOG_DIRECTORY/access.log"
    fi ;;
  error-log)
    parse_options "$@"
    [[ -z "$SINCE$YESTERDAY$DAY" ]] || fail "error-log takes only --grep, --tail and --rotated"
    if [[ -n "$ROTATED" ]]; then
      filtered "ls -tr $LOG_DIRECTORY/error.log* | xargs zcat -f"
    else
      filtered "cat $LOG_DIRECTORY/error.log"
    fi ;;
  log-files)
    remote "ls -la $LOG_DIRECTORY/" ;;
  release)
    # Prints only BLOT_RELEASE_ID: the rest of the environment holds secrets
    remote "for c in $(for u in $UNITS; do printf 'blot-%s ' "$u"; done); do printf '%s ' \$c; docker inspect \$c --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^BLOT_RELEASE_ID='; done" ;;
  health-check-log)
    parse_options "$@"
    [[ -z "$SINCE$YESTERDAY$DAY$ROTATED" ]] || fail "health-check-log takes only --grep and --tail"
    filtered "cat ~/docker-health-check.log" ;;
  node-reports)
    name=$(unit_name "${1:-}")
    remote "ls -lt /var/www/blot/data/node-reports/$name/ | head -20" ;;
  host)
    remote "uptime; echo; df -h / /backups $LOG_DIRECTORY 2>/dev/null; echo; free -m; echo; sysctl vm.overcommit_memory" ;;
  dmesg-oom)
    remote "sudo -n dmesg -T | grep -i -E 'oom|killed process' | tail -n 50" ;;
  tcpmem)
    remote "grep TCP: /proc/net/sockstat; cat /proc/sys/net/ipv4/tcp_mem; nstat -az TcpExtTCPMemoryPressures TcpExtTCPMemoryPressuresChrono TcpExtPruneCalled TcpExtTCPRcvQDrop TcpExtTCPOFODrop; echo; tail -n 30 ~/tcpmem.log" ;;
  cron-logs)
    lines="${1:-10}"; number "$lines"
    remote "for f in ~/tcpmem.log ~/redis-mem.log ~/backup.log; do echo \"== \$f\"; tail -n $lines \"\$f\"; done; echo '== /etc/cron.d/blot-redis'; cat /etc/cron.d/blot-redis; systemctl is-active crond" ;;
  backups)
    remote "df -h /backups; findmnt /backups; systemctl status blot-instance-store --no-pager | head; echo; ls -l /etc/blot-redis; echo; tail -n 20 ~/backup.log" ;;
  redis-info)
    section="${1:-}"
    [[ -z "$section" ]] || one_of "$section" "$REDIS_SECTIONS" || fail "section must be one of: $REDIS_SECTIONS"
    remote "redis6-cli INFO $section" ;;
  redis-config)
    one_of "${1:-}" "$REDIS_PARAMS" || fail "parameter must be one of: $REDIS_PARAMS"
    remote "redis6-cli CONFIG GET $1" ;;
  redis-memory-conf)
    remote "sudo -n cat /etc/redis6/blot-memory.conf" ;;
  redis-role)
    remote "redis6-cli ROLE; ls /etc/blot-redis/active 2>&1" ;;
  redis-slowlog)
    count="${1:-20}"; number "$count"
    remote "redis6-cli SLOWLOG GET $count" ;;
  redis-clients)
    remote "redis6-cli INFO clients | grep -E '^(connected|blocked|maxclients)'; redis6-cli CLIENT LIST | grep -o ' addr=[^ ]*' | sed 's/:[0-9]*\$//' | sort | uniq -c | sort -rn | head -20" ;;
  redis-log)
    parse_options "$@"
    [[ -z "$SINCE$YESTERDAY$DAY$ROTATED" ]] || fail "redis-log takes only --grep and --tail"
    [[ -n "$TAIL" ]] || TAIL=100
    filtered "sudo -n cat /var/log/redis6/redis6.log" ;;
  redis-journal)
    hours="${1:-2}"; number "$hours"
    remote "sudo -n journalctl -u redis6 --since '$hours hours ago' --no-pager | tail -n 200" ;;
  fail2ban)
    [[ "${1:-}" =~ ^[a-z0-9-]{1,40}$ ]] || fail "jail name must be lowercase letters, digits and dashes"
    remote "sudo -n fail2ban-client status $1" ;;
  errors)
    source="${1:-}"; shift || true
    top=50 since=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --since)
          [[ "${2:-}" =~ ^([0-9]{1,4}[smhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?)$ ]] || fail "bad --since '${2:-}'"
          since="$2"; [[ "$since" =~ ^([0-9]+)d$ ]] && since="$((BASH_REMATCH[1] * 24))h"; shift 2 ;;
        --top) number "${2:-}"; top="$2"; shift 2 ;;
        *) fail "errors takes only --since and --top" ;;
      esac
    done
    if [[ "$source" == error-log ]]; then
      [[ -z "$since" ]] || fail "error-log has no --since"
      input="grep -aE '\\[(error|crit|alert|emerg|warn)\\]' $LOG_DIRECTORY/error.log"
    elif [[ "$source" == app-log ]]; then
      SINCE="$since"
      input="$(app_log_since) | grep -aiE 'error|exception|fatal|unhandled|warn|timed? ?out|ECONN|EPIPE|refused'"
    else
      name=$(unit_name "$source")
      input="docker logs ${since:+--since $since} $name 2>&1 | grep -aiE 'error|exception|fatal|unhandled|warn|timed? ?out|ECONN|EPIPE|refused'"
    fi
    # The awk program is fixed text sent over stdin; only validated values are in the command line
    remote_stdin "program=\$(cat); $input | awk -v top=$top \"\$program\"" <<'AWK'
{
  line = $0
  t = line
  sub(/^[0-9TZ:.+-]+ /, "", t)                               # docker or app.log timestamp
  sub(/^blot-[a-z]+\/[0-9a-f]+ /, "", t)                      # app.log tag
  gsub(/\[[0-9]{2}\/[A-Za-z]{3}\/[0-9:]+ [+-][0-9]{4}\]/, "", t) # [06/Nov/2026:21:12:51 +0000]
  sub(/^[0-9\/]+ [0-9:]+ /, "", t)                            # error.log date
  gsub(/https?:\/\/[^ ]+/, "<url>", t)
  gsub(/\/[^ ]*\/[^ ]*/, "<path>", t)
  gsub(/blog_[0-9a-f]+/, "blog_<id>", t)
  gsub(/[0-9a-f]{16,}/, "<hex>", t)
  gsub(/client: [^,]+/, "client: <ip>", t)
  gsub(/[0-9]+/, "<n>", t)
  t = substr(t, 1, 200)
  if (!(t in count)) example[t] = substr(line, 1, 300)
  count[t]++
}
END {
  for (t in count) printf "%d\t%s\t%s\n", count[t], t, example[t] | "sort -rn | head -n " top
}
AWK
    ;;
  -h|--help|help)
    usage ;;
  *)
    fail "unknown subcommand '$command' (try --help)" ;;
esac
