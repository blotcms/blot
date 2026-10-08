#!/bin/sh

# This script will reset the SSL certificate for the domain(s) passed

# the log lines look like this:
# 2023/11/21 15:00:40 [error] 7264#7264: failed to set ocsp stapling for www.theuntitled.site - continuing anyway - failed to get ocsp response: failed to validate OCSP response (http://r3.o.lencr.org): OCSP response not successful (6: unauthorized), context: ssl_certificate_by_lua*, client: 66.249.66.132, server: 0.0.0.0:443
# extract the host from the line above

if [ -z "$BLOT_REDIS_HOST" ]; then
  echo "BLOT_REDIS_HOST variable missing, source it"
  exit 1
fi


if [ -z "$BLOT_LOG_DIRECTORY" ]; then
  echo "BLOT_LOG_DIRECTORY variable missing, source it"
  exit 1
fi

# if the user has passed a series of domains, use those for HOSTS, otherwise use the command below
if [ -z "$1" ]; then
    HOSTS=$(cat $BLOT_LOG_DIRECTORY/error.log | grep "ocsp stapling" | sed -E 's/.*ssl_certificate.lua:260: set_response_cert\(\): auto-ssl: failed to set ocsp stapling for ([^ ]+) .*/\1/' | sort | uniq)
else
    # you should be able to pass in multiple space separated domains
    HOSTS=$@
fi

INVALID_HOSTS=""

# Hosts will be newline separated, so we need to loop through them
for HOST in $HOSTS
do
    
    # first we request the domain to verify the SSL cert is invalid and needs to be purged
    # we should get an SSL error
    echo "Requesting $HOST to verify the SSL cert is invalid"
    CURL_OUTPUT=$(curl -s -o /dev/null -w '%{http_code}\n' https://$HOST)

    # if CURL_OUTPUT is not 000, then the SSL cert is valid and we should not purge it
    # if the domain is behind cloudflare, we will get a 526 error, so we should still purge if we get a 526
    if [ "$CURL_OUTPUT" != "000" ] && [ "$CURL_OUTPUT" != "526" ]; then
        echo "SSL cert for $HOST is valid, skipping"
        continue
    fi
    
    echo "SSL cert for $HOST is invalid, purging, curl=$CURL_OUTPUT"

    # store the host in a list of invalid hosts
    INVALID_HOSTS="$INVALID_HOSTS $HOST"

    KEY="ssl:$HOST:latest"

    # ask the user to confirm the key to delete before deleting it
    echo "About to delete $KEY from redis"
    echo "Press enter to continue or ctrl+c to cancel"
    read

    redis-cli -h $BLOT_REDIS_HOST del $KEY

    echo "Deleted $KEY from redis"
    echo ""
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
for HOST in $INVALID_HOSTS
do
    echo "https://$HOST checking"

    # making a request to the domain to reissue the certificate, get status code only
    CURL_OUTPUT=$(curl -s -o /dev/null -w "%{http_code}" https://$HOST)

    # CURL_OUTPUT should not be 000, if it is, the SSL cert is still invalid
    # or a 526 error if the domain is behind cloudflare
    if [ "$CURL_OUTPUT" == "000" ] || [ "$CURL_OUTPUT" == "526" ]; then
        echo "INVALID CERTIFICATE FOR https://$HOST"
        # otherwise, echo "SSL cert for $HOST is valid"
    else
        echo "https://$HOST is valid"
    fi

    echo ""
done
