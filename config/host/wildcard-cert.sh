#!/bin/bash
# Usage: wildcard-cert.sh <ssh-host>
# Writes the wildcard certificate and key from the host's own Redis to
# /etc/ssl/private/letsencrypt-domain.pem and .key, which
# proxy/deploy/blue-green.sh needs before it will start a unit in fresh mode.
# Run it after Redis on the host has synced (it only reads, so a read-only
# replica is fine), and before the first deploy-units. Safe to re-run.
#
# From the operator's Mac (or cycle.sh) it sends itself to the host over ssh
# and runs there with sudo. On the host, as root:
#   wildcard-cert.sh --local
#
# Refuses, and leaves any existing files alone, if either value is empty, the
# certificate has expired, or the key is not the certificate's key. Each file
# is written to a temp file in the same directory (0600 until chowned, so the
# key is never readable by anyone else), given its mode and owner, then moved
# into place. The key is never printed.
#
# Keys (app/scheduler/renew-wildcard-ssl.js writes them, proxy/config/
# wildcard_cert.lua reads them):
#   blot:openresty:ssl:pem   leaf certificate followed by its chain, PEM
#   blot:openresty:ssl:key   private key, PEM
#
# Owner and mode: root:deploy 0640. blue-green.sh runs as the deploy user and
# checks the files are readable; the proxy container mounts the directory
# read-only and runs as root, which reads them regardless.
#
# Env (for tests): BLOT_CERT_DIR (default /etc/ssl/private),
#   BLOT_CERT_OWNER (default root:deploy), REDIS_CLI (default redis-cli;
#   a command and arguments, "redis-cli -s /run/blot/redis/redis.sock" for the socket),
#   SSH_OPTS (extra ssh options as one string, as in bootstrap.sh)
# Runs on a Mac when given an ssh host, so that part has to work in bash 3.2.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { echo "wildcard-cert: $*"; }

if [ "${1:-}" != "--local" ]; then
  [ $# -eq 1 ] || die "usage: wildcard-cert.sh <ssh-host>"
  # shellcheck disable=SC2086
  exec ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$1" \
    "sudo env BLOT_CERT_DIR=$(printf %q "${BLOT_CERT_DIR:-}") BLOT_CERT_OWNER=$(printf %q "${BLOT_CERT_OWNER:-}") REDIS_CLI=$(printf %q "${REDIS_CLI:-}") bash -s -- --local" < "$0"
fi

DIR=${BLOT_CERT_DIR:-/etc/ssl/private}
OWNER=${BLOT_CERT_OWNER:-root:deploy}
# a command and its arguments, e.g. "redis-cli -s /run/blot/redis/redis.sock"
read -r -a REDIS_CMD <<< "${REDIS_CLI:-redis-cli}"
PEM_KEY=blot:openresty:ssl:pem
KEY_KEY=blot:openresty:ssl:key

command -v openssl > /dev/null || die "openssl is not installed"
command -v "${REDIS_CMD[0]}" > /dev/null || die "${REDIS_CMD[0]} is not installed"

[ -d "$DIR" ] || install -d -m 0755 "$DIR"
WORK=$(mktemp -d "$DIR/.wildcard-cert.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fetch() { # fetch <redis key> <file>
  "${REDIS_CMD[@]}" --raw get "$1" > "$2" || die "could not read $1 from Redis"
  grep -q -- '-----BEGIN ' "$2" || die "$1 is empty or not PEM in Redis; nothing written"
}
fetch "$PEM_KEY" "$WORK/pem"
fetch "$KEY_KEY" "$WORK/key"

openssl x509 -in "$WORK/pem" -noout > /dev/null 2>&1 || die "the certificate in Redis does not parse; nothing written"
openssl x509 -in "$WORK/pem" -noout -checkend 0 > /dev/null || die "the certificate in Redis has expired; nothing written"
cert_pub=$(openssl x509 -in "$WORK/pem" -pubkey -noout 2> /dev/null) || die "cannot read the certificate's public key"
key_pub=$(openssl pkey -in "$WORK/key" -pubout 2> /dev/null) || die "the key in Redis does not parse; nothing written"
[ "$cert_pub" = "$key_pub" ] || die "the key in Redis does not match the certificate; nothing written"

place() { # place <temp file> <destination>
  chown "$OWNER" "$1"
  chmod 0640 "$1"
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    chown "$OWNER" "$2"
    chmod 0640 "$2"
    log "$2 is already current"
  else
    mv -f "$1" "$2"
    log "wrote $2"
  fi
}
place "$WORK/pem" "$DIR/letsencrypt-domain.pem"
place "$WORK/key" "$DIR/letsencrypt-domain.key"

# blue-green.sh runs as deploy: warn if it still cannot read the files.
if [ "$(id -u)" = 0 ] && id deploy > /dev/null 2>&1 && command -v runuser > /dev/null; then
  runuser -u deploy -- test -r "$DIR/letsencrypt-domain.key" \
    || log "warning: the deploy user cannot read $DIR/letsencrypt-domain.key (check the directory's mode)"
fi
