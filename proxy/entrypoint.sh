#!/bin/bash
set -e

CERT_PATH="/etc/ssl/private/letsencrypt-domain.pem"
KEY_PATH="/etc/ssl/private/letsencrypt-domain.key"

# Ensure BLOT_HOST is set
if [[ -z "$BLOT_HOST" ]]; then
  echo "Error: BLOT_HOST is not set. Please provide the domain via the BLOT_HOST environment variable." >&2
  exit 1
fi

echo "BLOT_HOST=$BLOT_HOST"

# Certificate handling.
#
# This image is build-only scaffolding and does NOT issue certificates yet.
# The image ships a self-signed placeholder at the paths below so OpenResty can
# start. For a real deployment, mount a certificate + key over these two paths
# (or a volume containing them). On-demand issuance for custom blog domains is
# still handled at request time by lua-resty-auto-ssl, exactly as in the
# non-containerised proxy. See proxy/README.md for what remains to be done.
if [[ ! -f "$CERT_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Error: no certificate at $CERT_PATH / $KEY_PATH." >&2
  echo "Mount a certificate and key over those paths - this image does not issue one." >&2
  exit 1
fi

echo "Certificate present. Starting OpenResty."

# Start OpenResty
exec /usr/local/openresty/bin/openresty -g "daemon off;"
