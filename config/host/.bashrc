# .bashrc

# Source global definitions
if [ -f /etc/bashrc ]; then
	. /etc/bashrc
fi

# Uncomment the following line if you don't like systemctl's auto-paging feature:
# export SYSTEMD_PAGER=

# User specific aliases and functions

export NVM_DIR="/home/ec2-user/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

export PS1='[BLOT:\u] \W > '

cd /var/www/blot

#. /etc/blot/environment.sh

LOGS=/var/instance-ssd/logs

alias nginx-stats='ps aux | grep nginx | grep -v grep | awk "{sum+=\$6} END {print sum/1024 \"MB\"}"'
alias client='redis-cli -h $(grep BLOT_REDIS_HOST /etc/blot/secrets.env | cut -d"=" -f2 | tr -d " ")'
alias login="docker exec -it blot-container-blue /bin/sh"
alias candidates="docker exec blot-container-blue node app/documentation/featured/candidates"
alias access="docker exec blot-container-blue node /usr/src/app/scripts/blog/access.js"
alias info="docker exec blot-container-blue node /usr/src/app/scripts/info"
alias errors="tail -n 10000000 \$LOGS/access.log | egrep ' (500|501|502|504) '"
alias 404s="cat /var/instance-ssd/logs/access.log | grep ' 404 ' | cut -d ' ' -f7 | sed -E 's|https?://[^/]+| |' |  sort | uniq -c | sort -rn | head -n 100"
alias upstream='tail -f /var/instance-ssd/logs/access.log | stdbuf -oL grep "st=[^-]" | stdbuf -oL awk "{print \$10, \$3, \$4, \$7}"'
alias rebuild='docker exec blot-container-blue node /usr/src/app/scripts/entry/rebuild'

question() {
  if [ -z "$1" ]; then
    echo "Usage: question <question-url>"
    return 1
  fi

  local url="$1"
  local container="blot-container-blue"

  # Get the user ID from the question script
  local user_id
  user_id=$(docker exec -i "$container" node scripts/questions/author.js "$url" | tr -d '\r\n')

  if [ -z "$user_id" ]; then
    echo "No user found for $url"
    return 1
  fi

  # Call info with the user ID
  info "$user_id"
}

req() {
    grep -h --line-buffered "$1" <(tail -n 1000000 $LOGS/error.log $LOGS/access.log) <(docker logs blot-container-blue 2>&1) <(docker logs blot-container-green 2>&1) <(docker logs blot-container-yellow 2>&1)
}

live() {
  containers=(blot-container-blue blot-container-green blot-container-yellow)
  pids=()

  # Start docker logs for each container
   for c in "${containers[@]}"; do
    docker logs -f --since 0s "$c" 2>&1 &
    pids+=($!)
  done
 
  # Start tail -f on $LOGS/access.log, injecting [openresty] after the timestamp
  if [ -n "$LOGS" ] && [ -f "$LOGS/access.log" ]; then
    tail -F "$LOGS/access.log" | sed -u 's/^\(\[[^]]\+\]\) /\1 [openresty] /' &
    pids+=($!)
  else
    echo "Warning: \$LOGS/access.log not found or \$LOGS not set." >&2
  fi
  # Trap Ctrl+C to stop all background jobs
  trap 'kill "${pids[@]}" 2>/dev/null' INT

  wait
  trap - INT
}

logs() {
    if [ -z "$1" ]; then
        docker ps --format '{{.Names}}' | grep '^blot-container-' | xargs -L 1 docker logs --timestamps 2>&1 | sort -k1,1 | cut -d' ' -f2-
    else
        if [ "$1" = "-f" ]; then
            if [ -z "$2" ]; then
                echo "Container name required when using -f"
                return 1
            fi
            docker logs -f "blot-container-$2" 2>&1
        elif [ "$2" = "-f" ]; then
            docker logs -f "blot-container-$1" 2>&1
        else
            docker logs "blot-container-$1" 2>&1
        fi
    fi
}

function slowest() {
    local logfile="/var/instance-ssd/logs/access.log"
    local lines=1000000
    local exclude_pattern='^https://blot.im/sites/[^/]+/status|^https://webhooks.blot.im/|/draft/stream/'

    function process_logs() {
        local mode=$1
        local title=$2
        local cache_filter=$3
        local status_filter=$4
        
        echo -e "\n=== 50 Slowest $title (from last ${lines} entries) ==="
        
        tail -n ${lines} "$logfile" | grep ' lrs=PASSED' | awk -v mode="$mode" \
                                        -v pattern="$exclude_pattern" \
                                        -v cache_filter="$cache_filter" \
                                        -v status_filter="$status_filter" '
        function process_individual() {
            print time " " $0
        }
        
        function process_url() {
            count[url]++
            sum[url]+=time
        }
        
        function process_domain() {
            split(url, parts, "/")
            domain=parts[3]
            if (domain != "") {
                count[domain]++
                sum[domain]+=time
            }
        }
        
        {
            time=$5
            url=$7
            status=$4
            cache=$8
            
            # Skip excluded URLs
            if (url ~ pattern) next
            
            # Apply cache and status filters if specified
            if (cache_filter != "" && cache != cache_filter) next
            if (status_filter != "" && status != status_filter) next
            
            if (mode == "individual") {
                process_individual()
            } else {
                if (mode == "domain") {
                    process_domain()
                } else {
                    process_url()
                }
            }
        }
        
        END {
            if (mode != "individual") {
                for (key in count) {
                    printf "%.3f %s\n", sum[key]/count[key], key
                }
            }
        }' | sort -rn | head -n 50
    }

    # Process logs in different modes
    process_logs "individual" "Individual Requests"
    process_logs "url" "URLs by Average Response Time"
    process_logs "domain" "Domains by Average Response Time"
    process_logs "individual" "Uncached 200 Responses" "cache=MISS" "200"
}

function biggest() {
    local logfile="/var/instance-ssd/logs/access.log"
    local lines=1000000
    
    echo "=== 50 Largest Individual Responses (from last ${lines} entries) ==="
    tail -n ${lines} "$logfile" | awk '{
        # Size is field 6, split on colon and take second number
        split($6, sizes, ":")
        size=sizes[2]
        print size " " $0
    }' | sort -rn | head -n 50
    
    echo -e "\n=== 50 URLs with Most Bandwidth Used (from last ${lines} entries) ==="
    tail -n ${lines} "$logfile" | awk '{
        # Size is field 6, URL is field 7
        split($6, sizes, ":")
        size=sizes[2]
        url=$7
        count[url]++
        sum[url]+=size
    }
    END {
        for (url in count) {
            printf "%d %s (%d requests, avg %.0f bytes)\n", sum[url], url, count[url], sum[url]/count[url]
        }
    }' | sort -rn | head -n 50
    
    echo -e "\n=== 50 Domains with Most Bandwidth Used (from last ${lines} entries) ==="
    tail -n ${lines} "$logfile" | awk '{
        # Size is field 6, URL is field 7
        split($6, sizes, ":")
        size=sizes[2]
        url=$7
        # Extract domain from URL using split
        split(url, parts, "/")
        domain=parts[3]
        if (domain != "") {
            count[domain]++
            sum[domain]+=size
        }
    }
    END {
        for (domain in count) {
            printf "%d %s (%d requests, avg %.0f bytes)\n", sum[domain], domain, count[domain], sum[domain]/count[domain]
        }
    }' | sort -rn | head -n 50
}

block() {
    while true; do
        echo "----------------------------"
        echo "Current Banned IPs:"
           # List all DROP rules in the INPUT chain and extract IPs
        banned_ips=$(sudo iptables -S INPUT | grep 'DROP' | awk '{for(i=1;i<=NF;i++){if($i=="-s"){print $(i+1)}}}')
        total_banned=$(echo "$banned_ips" | grep -c .)
        echo "Total banned IPs: $total_banned"
        echo "Last 20 banned IPs:"
        echo "$banned_ips" | head -20

        echo "----------------------------"
        read -p "Enter new IP to ban (or 'q' to quit): " new_ip
        if [[ "$new_ip" == "q" ]]; then
            echo "Exiting."
            break
        fi
    if [[ ! "$new_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "Invalid IP. Please enter a valid IPv4 address."
            continue
        fi

    if echo "$banned_ips" | grep -Fxq "$new_ip"; then
            echo "IP $new_ip is already banned."
        else
            sudo iptables -I INPUT -s "$new_ip" -j DROP \
                && sudo sh -c 'iptables-save > /etc/sysconfig/iptables'
            echo "IP $new_ip has been banned."
        fi
    done
}

kills() {
    boot_time=$(date -d "$(who -b | awk '{print $3" "$4}')" +%s)
    dmesg | grep -i "killed" | while read -r line; do
        ts=$(echo "$line" | grep -oP '\[\K[0-9.]+')
        human_date=$(date -d "@$(echo "$boot_time + ${ts%%.*}" | bc)" "+%Y-%m-%d %H:%M:%S")
        echo "$line" | sed -E "s/\[[0-9.]+\]/[$human_date]/"
    done
}

stats() {
    # First collect all container stats in a temporary file to avoid multiple docker stats calls
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" > /tmp/container_stats

    # Print summary table header
    printf "%-20s %-10s %-20s %-8s\n" "CONTAINER" "CPU%" "MEMORY" "MEM%"
    
    # Print summary table content
    grep -v "NAME" /tmp/container_stats | sort -k6 -nr

    printf "\n"


    # Use the saved stats for detailed process information
    grep -v "NAME" /tmp/container_stats | \
    sort -k6 -nr | \
    while read container_line; do
        if [ -n "$container_line" ]; then
            printf "%.s-" {1..100}
            printf "\n"
            echo "$container_line"
            container_name=$(echo $container_line | awk '{print $1}')
            printf "%.s-" {1..100}
            printf "\n"
            # Print process table header with added Memory column
            printf "%-8s %-8s %-7s %-12s %-7s %-50s\n" "USER" "PID" "CPU%" "MEMORY" "MEM%" "COMMAND"

            # Using docker top with formatted output
            docker top $container_name -eo pid,ppid,user,%cpu,%mem,rss,cmd | \
            tail -n +2 | \
            awk '{
                mem=$5;
                rss=$6;
                # Convert RSS to human readable format
                if (rss < 1024) {
                    mem_str = sprintf("%.1fK", rss);
                } else if (rss < 1048576) {
                    mem_str = sprintf("%.1fM", rss/1024);
                } else {
                    mem_str = sprintf("%.1fG", rss/1048576);
                }
                cmd=""; 
                for(i=7;i<=NF;i++) cmd=cmd" "$i;
                # Trim command if longer than 50 chars
                if (length(cmd) > 50) {
                    cmd = substr(cmd, 1, 47) "...";
                }
                printf "%-8s %-8s %6.1f%% %-12s %6.1f%% %-50s\n", 
                $3, $1, $4, mem_str, mem, cmd;
            }' | \
            sort -k4 -nr | \
            head -n 10


            printf "\n"
        fi
    done

    # Clean up temporary file
    rm -f /tmp/container_stats
}

upstream_errors() {
    local log_file=${1:-"/var/instance-ssd/logs/error.log"}
    local lines=${2:-100000}
    local time_window=${3:-10}
    
    tail -n "$lines" "$log_file" | \
    grep "upstream server temporarily disabled" | \
    awk -v window=10 '
        match($0, /([0-9]{4}\/[0-9]{2}\/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}).*request: "([^ ]+) ([^"]+)".*host: "?([^,"]+)"?/, arr) {
            timestamp=arr[1]
            method=arr[2]
            path=arr[3]
            host=arr[4]
            gsub(/ /,"",host)
            "date -d \""timestamp"\" +%s"|getline epoch
            close("date -d \""timestamp"\" +%s")
            if(last_epoch==0||(epoch-last_epoch)>=window) {
                if(last_epoch!=0)print""
                print timestamp":"
            }
            print "  "method" https://"host path
            last_epoch=epoch
        }'
}

unresponded() {
    declare -A requests
    declare -a request_order  # Array to preserve order
    
    while IFS= read -r line; do
        request_id=$(echo "$line" | grep -o '[a-f0-9]\{32\}')
        
        if [[ -n "$request_id" ]]; then
            if echo "$line" | grep -q " GET\| POST\| PUT\| DELETE"; then
                requests["$request_id"]="$line"
                request_order+=("$request_id")  # Add to order array
            elif echo "$line" | grep -q "[0-9]\{3\} [0-9]\.[0-9]"; then
                unset requests["$request_id"]
            fi
        fi
    done < <(docker logs --tail 10000 blot-container-blue)
    
    echo "Unresponded Requests:"
    echo "--------------------"
    for id in "${request_order[@]}"; do
        if [[ -n "${requests[$id]}" ]]; then
            echo "${requests[$id]}"
        fi
    done
}
