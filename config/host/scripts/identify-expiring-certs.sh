#!/bin/sh


if [ -z "$BLOT_LOG_DIRECTORY" ]; then
  echo "BLOT_LOG_DIRECTORY variable missing, source it"
  exit 1
fi

HOSTS=$(cat $BLOT_LOG_DIRECTORY/access.log | cut -d ' ' -f 7 | cut -d / -f 3 | sort | uniq)
EXPIRING_HOSTS=""

if [ -z "$BLOT_REDIS_HOST" ]; then
  echo "BLOT_REDIS_HOST variable missing, source it"
  exit 1
fi

for HOST in $HOSTS
do  
    # if host does not contain a period, skip it
    if [[ $HOST != *"."* ]]; then
#        echo "SKIP $HOST since it does not contain a period"
        continue
    fi

    # if host ends with the blot.im domain, skip it
    if [[ $HOST == *"blot.im" ]]; then
#        echo "SKIP $HOST since it ends with blot.im"
        continue
    fi

    # if it's an IP, i.e. only contains numbers and periods, skip it
    if [[ $HOST =~ ^[0-9.]+$ ]]; then
#        echo "SKIP $HOST since it is an IP"
        continue
    fi

    # we call redis and check if the key 'domain:$HOST' exists and is not empty
    REDIS_STATUS=$(redis-cli -h $BLOT_REDIS_HOST exists "domain:$HOST")
    
    # if the redis status is 0, then the key does not exist, so we should skip it
    if [[ $REDIS_STATUS == 0 ]]; then
#        echo "SKIP $HOST since the redis status is 0"
        continue
    fi
    
    echo "CHECK $HOST"

    # this command hangs for a while even if the host is valid, I think because openssl does not close the connection
    DATE=$(timeout 3 bash -c "echo -n | openssl s_client -servername $HOST -connect $HOST:443 2>/dev/null | openssl x509 -noout -dates | grep notAfter | cut -d= -f2")

    # if the date is invalid, skip it
    if [[ $DATE == "" ]]; then
        echo "SKIP $HOST since the date is invalid, DATE=$DATE"
        continue
    fi

    DATE_STAMP=$(date -d "$DATE" +%s)
    THIS_WEEK=$(date -d "+7 day" +%s)

    # if the expiration date is within 1 day, send an email
    if [[ $DATE_STAMP -lt $THIS_WEEK ]]; then
        echo ""
        echo "RENEW $HOST since it EXPIRES in a day: DATE=$DATE, DATE_STAMP=$DATE_STAMP, THIS_WEEK=$THIS_WEEK"
        EXPIRING_HOSTS="$EXPIRING_HOSTS $HOST"
        echo ""
    else 
        echo "CHECK $HOST does not need to be renewed: $DATE"
    fi
done

echo "CHECKED all hosts"

for HOST in $EXPIRING_HOSTS
do
    KEY="ssl:$HOST:latest"

    # ask the user to confirm the key to delete before deleting it
    echo "DELETING $KEY from redis"

    redis-cli -h $BLOT_REDIS_HOST del $KEY
done

# A restart, not a reload: the certificate cache lives in a shared dict, which
# survives a reload. Once the proxy runs as a container (proxy/deploy) restart
# that instead; the bare-metal unit is stopped and must not be started beside it.
proxy_containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^blot-proxy-(blue|green)$' || true)
if [ -n "$proxy_containers" ]; then
    echo "Restarting proxy container(s): $proxy_containers"
    for container in $proxy_containers; do
        docker restart --time 30 "$container"
    done
    echo "Restarted proxy container(s)"
else
    echo "Restarting openresty"

    sudo systemctl restart openresty

    echo "Restarted openresty"
fi
echo ""

# now we loop over the INVALID_HOSTS and check that the SSL cert is now valid
for HOST in $EXPIRING_HOSTS
do
    echo "RENEW CHECK $HOST"

    CURL_OUTPUT=$(curl -s -o /dev/null -w '%{http_code}\n' https://$HOST)

    # if CURL_OUTPUT is not 000, then the SSL cert is valid and we should not purge it
    # if the domain is behind cloudflare, we will get a 526 error, so we should still purge if we get a 526
    if [ "$CURL_OUTPUT" == "000" ] || [ "$CURL_OUTPUT" == "526" ]; then
        echo "SSL cert for $HOST is invalid"
        continue
    fi

    # this command hangs for a while even if the host is valid, I think because openssl does not close the connection
    DATE=$(timeout 3 bash -c "echo -n | openssl s_client -servername $HOST -connect $HOST:443 2>/dev/null | openssl x509 -noout -dates | grep notAfter | cut -d= -f2")

    # if the date is invalid, skip it
    if [[ $DATE == "" ]]; then
        echo "SKIP $HOST since the date is invalid, DATE=$DATE"
        continue
    fi

    DATE_STAMP=$(date -d "$DATE" +%s)
    THIS_WEEK=$(date -d "+7 day" +%s)

    if [[ $DATE_STAMP -lt $THIS_WEEK ]]; then
        echo "$HOST FAILED to RENEW since it EXPIRES DATE=$DATE, DATE_STAMP=$DATE_STAMP, THIS_WEEK=$THIS_WEEK"
    else 
        echo "$HOST SUCCESS has new CERT"
    fi
done


echo "COMPLETE"