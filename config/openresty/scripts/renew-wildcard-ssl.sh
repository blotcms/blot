#!/bin/sh
set -e

ACME=/usr/local/bin/acme-nginx

# Sources the environment variables required
. /etc/blot/wildcard-ssl-env.sh

if [ -z "$BLOT_HOST" ]; then
  echo "BLOT_HOST variable missing, pass the hostname of the blot instance as an argument to this script"
  exit 1
fi

if [ -z "$BLOT_REDIS_HOST" ]; then
  echo "BLOT_REDIS_HOST variable missing, pass the hostname of the redis instance as an argument to this script"
  exit 1
fi

if [ -z "$AWS_ACCESS_KEY_ID" ]; then
  echo "AWS_ACCESS_KEY_ID variable missing, pass the aws access key as an argument to this script"
  exit 1
fi

if [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "AWS_SECRET_ACCESS_KEY variable missing, pass the aws access key as an argument to this script"
  exit 1
fi

HASH_OF_KEY_BEFORE=$(cat /etc/ssl/private/letsencrypt-domain.key | openssl md5 | cut -d' ' -f2)
HASH_OF_PEM_BEFORE=$(cat /etc/ssl/private/letsencrypt-domain.pem | openssl md5 | cut -d' ' -f2)

echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Beginning renewal of wildcard certificate" 
$ACME --no-reload-nginx --dns-provider route53 -d "*.$BLOT_HOST" -d "$BLOT_HOST" 
echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Finished renewal of wildcard certificate" 

HASH_OF_KEY_AFTER=$(cat /etc/ssl/private/letsencrypt-domain.key | openssl md5 | cut -d' ' -f2)
HASH_OF_PEM_AFTER=$(cat /etc/ssl/private/letsencrypt-domain.pem | openssl md5 | cut -d' ' -f2)

# report whether the key or pem changed
if [ "$HASH_OF_KEY_BEFORE" = "$HASH_OF_KEY_AFTER" ]; then
  echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Key did not change after renewal, hash: $HASH_OF_KEY_AFTER"
  else 
  echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Key changed after renewal, hash after: $HASH_OF_KEY_AFTER, hash before: $HASH_OF_KEY_BEFORE"
fi

if [ "$HASH_OF_PEM_BEFORE" = "$HASH_OF_PEM_AFTER" ]; then
  echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Pem did not change after renewal, hash: $HASH_OF_PEM_AFTER"
  else 
  echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Pem changed after renewal, hash after: $HASH_OF_PEM_AFTER hash before: $HASH_OF_PEM_BEFORE"
fi

# We store the key and pem in redis so that the openresty reload script can fetch them
echo "[`date -u +%Y-%m-%dT%T.%3NZ`] Beginning storage of key and pem in redis"

cat /etc/ssl/private/letsencrypt-domain.key | redis-cli -h $BLOT_REDIS_HOST -x set 'blot:openresty:ssl:key'
cat /etc/ssl/private/letsencrypt-domain.pem | redis-cli -h $BLOT_REDIS_HOST -x set 'blot:openresty:ssl:pem'

redis-cli -h $BLOT_REDIS_HOST set 'blot:openresty:ssl:updated' $(date -u +%s)

# Reload whichever proxy is serving to use the new cert: the container(s)
# (proxy/deploy, which mount /etc/ssl/private read-only) once the proxy has
# moved off bare-metal, otherwise the bare-metal OpenResty. The cutover script
# refuses to run until this host has this version of the script.
containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^blot-proxy-(blue|green)$' || true)
if [ -n "$containers" ]; then
  for container in $containers; do
    docker exec "$container" /usr/local/openresty/bin/openresty -s reload
  done
else
  openresty -s reload
fi