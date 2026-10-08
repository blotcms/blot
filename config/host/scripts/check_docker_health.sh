#!/bin/bash
# Restarts any container Docker reports as unhealthy. Docker only marks a
# container unhealthy, it never restarts it for that, so this runs from cron
# every minute and appends to ~/docker-health-check.log.
#
# Install: cp to /usr/local/bin/check_docker_health.sh on the app host.
#
# Before restarting, it logs the container's last health probes (with their
# output and timing) and its memory use. Docker keeps only the last five
# probes and drops them on restart, so without this there is no record of
# which check failed or why.

# Get unhealthy containers
unhealthy_containers=$(docker ps --format "{{.Names}}" --filter "health=unhealthy")

# If there are any unhealthy containers, restart them
if [ ! -z "$unhealthy_containers" ]; then
    while IFS= read -r container; do
        echo "$(date): Restarting unhealthy container: $container"
        docker inspect "$container" --format '  health: {{json .State.Health.Log}}'
        docker stats --no-stream --format '  stats: mem={{.MemUsage}} cpu={{.CPUPerc}} pids={{.PIDs}}' "$container"
        docker restart "$container"
    done <<< "$unhealthy_containers"
fi
