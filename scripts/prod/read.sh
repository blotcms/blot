#!/usr/bin/env bash
set -euo pipefail

# Read-only views of the production host, over `ssh blot`. Every subcommand runs a
# fixed remote command that changes nothing, so this one script can be allowlisted
# for agents while every other production command still needs the operator's OK.
# Arguments are validated here, and grep patterns travel over stdin rather than in
# the remote command line, so no argument can add a command on the host. Filter the
# output locally (grep, awk, node) rather than with remote pipes.
#
#   scripts/prod/read.sh ps                         unit containers, status, created
#   scripts/prod/read.sh inspect <unit>             OOMKilled, exit code, start time, restarts, memory limit
#   scripts/prod/read.sh stats                      docker stats, one sample
#   scripts/prod/read.sh logs <unit> [opts]         a unit's container logs, with timestamps
#   scripts/prod/read.sh access [opts]              openresty access log
#   scripts/prod/read.sh error-log [opts]           openresty error log
#   scripts/prod/read.sh host                       uptime, disk, memory, overcommit
#   scripts/prod/read.sh dmesg-oom                  kernel OOM kills
#   scripts/prod/read.sh tcpmem                     socket memory against tcp_mem, and its 5-minute log
#   scripts/prod/read.sh cron-logs                  tails of the Redis host's cron logs, and the cron file
#   scripts/prod/read.sh redis-info [section]       redis6-cli INFO (server, clients, memory, ...)
#   scripts/prod/read.sh redis-config <param>       redis6-cli CONFIG GET for a known parameter
#   scripts/prod/read.sh redis-role                 replication role and the active marker
#   scripts/prod/read.sh redis-slowlog [count]      redis6-cli SLOWLOG GET
#   scripts/prod/read.sh redis-clients              client connections per address
#   scripts/prod/read.sh redis-log [opts]           Redis's own log
#   scripts/prod/read.sh redis-journal [hours]      journalctl for the redis6 unit
#   scripts/prod/read.sh fail2ban <jail>            a fail2ban jail's status
#
# Options for logs, access, error-log and redis-log:
#   --since <30m|6h|2d|ISO time>   logs only: start of the window
#   --tail <n>                     last n lines (after --grep)
#   --grep <text>                  keep lines containing the text (fixed string)
#   --yesterday                    access only: read yesterday's rotated file too
#
# Writes nothing on the host. Anything else (scripts in a container, docker cp,
# redis writes) is a normal production command and needs the operator's OK.

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
  ssh -o BatchMode=yes blot "$1"
}

# Parses --since/--tail/--grep/--yesterday into SINCE, TAIL, PATTERN and YESTERDAY
parse_options() {
  SINCE="" TAIL="" PATTERN="" YESTERDAY=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since)
        [[ "${2:-}" =~ ^([0-9]{1,4}[smhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?)$ ]] || fail "bad --since '${2:-}'"
        SINCE="$2"; shift 2 ;;
      --tail) number "${2:-}"; TAIL="$2"; shift 2 ;;
      --grep) [[ -n "${2:-}" ]] || fail "--grep needs text"; PATTERN="$2"; shift 2 ;;
      --yesterday) YESTERDAY=1; shift ;;
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
  printf '%s' "$PATTERN" | remote "pattern=\$(cat); { $command; }$filters"
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
    since=""
    [[ -n "$SINCE" ]] && since="--since $SINCE"
    filtered "docker logs --timestamps $since $name 2>&1" ;;
  access)
    parse_options "$@"
    [[ -z "$SINCE" ]] || fail "access has no --since; use --grep or --tail"
    files="$LOG_DIRECTORY/access.log"
    [[ -n "$YESTERDAY" ]] && files="$LOG_DIRECTORY/access.log-\$(date -d yesterday +%Y%m%d) $files"
    filtered "cat $files" ;;
  error-log)
    parse_options "$@"
    [[ -z "$SINCE$YESTERDAY" ]] || fail "error-log takes only --grep and --tail"
    filtered "cat $LOG_DIRECTORY/error.log" ;;
  host)
    remote "uptime; echo; df -h / /backups $LOG_DIRECTORY 2>/dev/null; echo; free -m; echo; sysctl vm.overcommit_memory" ;;
  dmesg-oom)
    remote "sudo -n dmesg -T | grep -i -E 'oom|killed process' | tail -n 50" ;;
  tcpmem)
    remote "grep TCP: /proc/net/sockstat; cat /proc/sys/net/ipv4/tcp_mem; nstat -az TcpExtTCPMemoryPressures TcpExtTCPMemoryPressuresChrono TcpExtPruneCalled TcpExtTCPRcvQDrop; echo; tail -n 30 ~/tcpmem.log" ;;
  cron-logs)
    remote "for f in ~/tcpmem.log ~/redis-mem.log ~/backup.log; do echo \"== \$f\"; tail -n 10 \"\$f\"; done; echo '== /etc/cron.d/blot-redis'; cat /etc/cron.d/blot-redis; systemctl is-active crond" ;;
  redis-info)
    section="${1:-}"
    [[ -z "$section" ]] || one_of "$section" "$REDIS_SECTIONS" || fail "section must be one of: $REDIS_SECTIONS"
    remote "redis6-cli INFO $section" ;;
  redis-config)
    one_of "${1:-}" "$REDIS_PARAMS" || fail "parameter must be one of: $REDIS_PARAMS"
    remote "redis6-cli CONFIG GET $1" ;;
  redis-role)
    remote "redis6-cli ROLE; ls /etc/blot-redis/active 2>&1" ;;
  redis-slowlog)
    count="${1:-20}"; number "$count"
    remote "redis6-cli SLOWLOG GET $count" ;;
  redis-clients)
    remote "redis6-cli INFO clients | grep -E '^(connected|blocked|maxclients)'; redis6-cli CLIENT LIST | grep -o ' addr=[^ ]*' | sed 's/:[0-9]*\$//' | sort | uniq -c | sort -rn | head -20" ;;
  redis-log)
    parse_options "$@"
    [[ -z "$SINCE$YESTERDAY" ]] || fail "redis-log takes only --grep and --tail"
    [[ -n "$TAIL" ]] || TAIL=100
    filtered "sudo -n cat /var/log/redis6/redis6.log" ;;
  redis-journal)
    hours="${1:-2}"; number "$hours"
    remote "sudo -n journalctl -u redis6 --since '$hours hours ago' --no-pager | tail -n 200" ;;
  fail2ban)
    [[ "${1:-}" =~ ^[a-z0-9-]{1,40}$ ]] || fail "jail name must be lowercase letters, digits and dashes"
    remote "sudo -n fail2ban-client status $1" ;;
  -h|--help|help)
    usage ;;
  *)
    fail "unknown subcommand '$command' (try --help)" ;;
esac
