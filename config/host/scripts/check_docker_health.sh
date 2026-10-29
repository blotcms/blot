#!/bin/bash
# Restarts any container Docker reports as unhealthy. Docker only marks a
# container unhealthy, it never restarts it for that, so this runs from cron
# every minute and appends to ~/docker-health-check.log.
#
# Install: `npm run deploy-host` copies it to /usr/local/bin/check_docker_health.sh
# (the path cron runs); the copy in ~/scripts is not the one that runs.
#
# Before restarting, it logs the container's last health probes (with their
# output and timing) and its memory use. Docker keeps only the last five
# probes and drops them on restart, so without this there is no record of
# which check failed or why.

# Get unhealthy containers
unhealthy_containers=$(docker ps --format "{{.Names}}" --filter "health=unhealthy")

# A deploy (proxy/deploy/blue-green.sh) holds this lock for its whole run and
# drains the unit it replaces with `docker stop`, during which its healthcheck
# goes unhealthy. Restarting it then brings the old unit back to life next to
# the new one, so leave the units alone while the lock is held: blot-blue,
# blot-green, blot-<unit>-previous and the single blot-proxy-<colour> of before
# the two units. Whole names, so the airlocks are still restarted.
PROXY_DEPLOY_LOCK="${PROXY_DEPLOY_LOCK:-/tmp/blot-proxy-deploy.lock}"
if [ -e "$PROXY_DEPLOY_LOCK" ] && ! flock -n "$PROXY_DEPLOY_LOCK" true 2>/dev/null; then
    unhealthy_containers=$(echo "$unhealthy_containers" | grep -Ev '^blot-(proxy-)?(blue|green)(-previous)?$')
fi

# A unit holds OpenResty and Node, so restarting one drops every connection it
# has. Never restart both at once: a unit is restarted only if the other is
# healthy (or not running at all, when nothing else could serve anyway), and if
# both are unhealthy blot-blue goes first and blot-green on a later run, once
# blue is healthy again. (Docker reports "starting" for a restarted unit for
# its start period, which also holds the other one back.)
unit_health() { docker inspect -f '{{if .State.Running}}{{.State.Health.Status}}{{else}}stopped{{end}}' "$1" 2>/dev/null; }
restartable=""
while IFS= read -r container; do
    [ -n "$container" ] || continue
    case "$container" in
        blot-blue) other=blot-green ;;
        blot-green) other=blot-blue ;;
        *) restartable+="$container"$'\n'; continue ;;
    esac
    other_health=$(unit_health "$other")
    if [ "$other_health" = "unhealthy" ] && [ "$container" = "blot-blue" ]; then
        restartable+="$container"$'\n'
    elif [ "$other_health" = "unhealthy" ] || [ "$other_health" = "starting" ]; then
        echo "$(date): Not restarting $container: $other is $other_health"
    else
        restartable+="$container"$'\n'
    fi
done <<< "$unhealthy_containers"
unhealthy_containers=$(printf '%s' "$restartable" | sed '/^$/d')

# If there are any unhealthy containers, restart them
if [ ! -z "$unhealthy_containers" ]; then
    while IFS= read -r container; do
        echo "$(date): Restarting unhealthy container: $container"
        docker inspect "$container" --format '  health: {{json .State.Health.Log}}'
        docker stats --no-stream --format '  stats: mem={{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$container"
        docker restart "$container"
    done <<< "$unhealthy_containers"
fi
