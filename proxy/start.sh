#!/bin/bash
#
# Prepares the container for OpenResty, then runs the command it is given
# (replacing itself with it): checks the certificate, fixes the ownership of
# the mount points, renders the config. Run by entrypoint.sh and by the unit
# image's supervisor (unit/supervisor.sh), which start OpenResty differently:
#
#   proxy-start /usr/local/openresty/bin/openresty -g "daemon off;"
set -e

CERT_PATH="/etc/ssl/private/letsencrypt-domain.pem"
KEY_PATH="/etc/ssl/private/letsencrypt-domain.key"

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
  # New and renewed custom-domain certificates get ECDSA (P-256) keys: the
  # chain is about 1.5 KB smaller per full TLS handshake than with RSA 4096.
  # dehydrated (via lua-resty-auto-ssl) sources letsencrypt/conf.d/*.sh. It is
  # written on every start because /etc/resty-auto-ssl is a persistent volume,
  # so a file baked into the image would never appear. Certificates already
  # issued stay RSA until their next renewal.
  echo 'KEY_ALGO="prime256v1"' > /etc/resty-auto-ssl/letsencrypt/conf.d/key-algo.sh
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

# Fill in the runtime placeholders (Redis host, upstreams, resolver, server
# label, Bunny edge IPs) from the environment. See proxy/render-config.sh.
/usr/local/bin/render-config

echo "Certificate present. Starting OpenResty."

exec "$@"
