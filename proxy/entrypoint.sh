#!/bin/bash
set -e

CERT_PATH="/etc/ssl/private/letsencrypt-domain.pem"
KEY_PATH="/etc/ssl/private/letsencrypt-domain.key"
OPENRESTY="/usr/local/openresty/bin/openresty"

# Ensure BLOT_HOST is set
if [[ -z "$BLOT_HOST" ]]; then
  echo "Error: BLOT_HOST is not set. Please provide the domain via the BLOT_HOST environment variable." >&2
  exit 1
fi

echo "BLOT_HOST=$BLOT_HOST"

# Persistent-volume mount points come up owned by root; the OpenResty workers
# run as ec2-user (see the generated config's `user` directive). Fix ownership
# of the mount *roots* on every boot while we still have root.
#
# Do NOT recurse into /var/cache/openresty: it holds up to 200 GB with a
# one-year lifetime, nginx creates its `levels=1:2` dirs as the worker user
# anyway, and a recursive walk here can blow past a blue/green readiness
# timeout. resty-auto-ssl is a small tree of hook state, so -R is fine there.
if [[ "$(id -u)" == "0" ]]; then
  mkdir -p /run/openresty
  chown ec2-user:ec2-user /run/openresty
  for d in /var/cache/openresty /var/log/openresty; do
    [[ -d "$d" ]] && chown ec2-user:ec2-user "$d" || true
  done
  # Pre-create the whole dehydrated tree owned by ec2-user. OpenResty's master
  # (root) runs generate_config in init_by_lua and would otherwise `mkdir`
  # these root-owned, leaving the ec2-user worker unable to write the ACME
  # account / cert files during issuance.
  mkdir -p \
    /etc/resty-auto-ssl/storage \
    /etc/resty-auto-ssl/tmp \
    /etc/resty-auto-ssl/letsencrypt/conf.d \
    /etc/resty-auto-ssl/letsencrypt/accounts \
    /etc/resty-auto-ssl/letsencrypt/certs \
    /etc/resty-auto-ssl/letsencrypt/chains
  chown -R ec2-user:ec2-user /etc/resty-auto-ssl
fi

# Optional: trust a non-public ACME endpoint. The vendored `dehydrated` hook
# shells out with curl, so pointing CURL_CA_BUNDLE / SSL_CERT_FILE at the test
# CA is enough for issuance against a Pebble server in CI. No-op in production,
# where ACME_CA_CERT is unset and the CA is publicly trusted.
if [[ -n "$ACME_CA_CERT" && -r "$ACME_CA_CERT" ]]; then
  echo "Trusting ACME test CA at $ACME_CA_CERT"
  export CURL_CA_BUNDLE="$ACME_CA_CERT"
  export SSL_CERT_FILE="$ACME_CA_CERT"
fi

# Certificate handling.
#
# The image ships a self-signed placeholder at the paths below so OpenResty
# can start. For a real deployment, mount a certificate + key over these two
# paths (or a volume containing them). On-demand issuance for custom blog
# domains is handled at request time by lua-resty-auto-ssl. See proxy/README.md.
if [[ ! -f "$CERT_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Error: no certificate at $CERT_PATH / $KEY_PATH." >&2
  echo "Mount a certificate and key over those paths - this image ships only a placeholder." >&2
  exit 1
fi

echo "Certificate present. Starting OpenResty."

# Graceful shutdown: on SIGTERM/SIGQUIT drain in-flight requests with
# `openresty -s quit` instead of letting the container be killed. This is what
# makes the blue/green handover in proxy/deploy/blue-green.sh lossless - the
# replacement container is already in the SO_REUSEPORT group before this one
# leaves it.
term() {
  echo "Shutdown signal received - draining (openresty -s quit)."
  "$OPENRESTY" -s quit || true
  wait "$openresty_pid" 2>/dev/null || true
}
trap term TERM QUIT INT

"$OPENRESTY" -g "daemon off;" &
openresty_pid=$!
wait "$openresty_pid" || true
