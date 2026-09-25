#!/usr/bin/env bash
#
# A self-signed CA plus a wildcard leaf certificate for BLOT_HOST (blot.im -
# the bare-metal generator hardcodes that host name regardless of BLOT_HOST,
# see config/openresty/locals.js's baremetal(), so this harness uses it too),
# trusted by the runner's CA store so curl's ordinary certificate validation
# (https_status in proxy/deploy/common.sh) passes without CURL_CA_BUNDLE /
# -k. served_cert_matches_disk compares the served certificate's fingerprint
# against $CERT_DIR/letsencrypt-domain.pem byte for byte, so the leaf here IS
# that file - no chain, matching the single PEM the real host has.
#
#   gen-certs.sh <host> <cert-dir>
set -euo pipefail

HOST="${1:?usage: gen-certs.sh <host> <cert-dir>}"
CERT_DIR="${2:?usage: gen-certs.sh <host> <cert-dir>}"

mkdir -p "$CERT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

openssl genrsa -out "$WORK/ca.key" 2048 >/dev/null 2>&1
openssl req -x509 -new -nodes -key "$WORK/ca.key" -sha256 -days 3650 \
  -subj "/CN=blot-proxy-e2e-ca" -out "$WORK/ca.pem"

openssl genrsa -out "$CERT_DIR/letsencrypt-domain.key" 2048 >/dev/null 2>&1

cat > "$WORK/leaf.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = $HOST
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = $HOST
DNS.2 = *.$HOST
EOF

openssl req -new -key "$CERT_DIR/letsencrypt-domain.key" -out "$WORK/leaf.csr" -config "$WORK/leaf.cnf"
openssl x509 -req -in "$WORK/leaf.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
  -out "$CERT_DIR/letsencrypt-domain.pem" -days 825 -sha256 \
  -extfile "$WORK/leaf.cnf" -extensions v3_req

# Trust the CA so curl's default certificate validation (https_status in
# proxy/deploy/common.sh) accepts the leaf above without any CA override.
sudo cp "$WORK/ca.pem" /usr/local/share/ca-certificates/blot-proxy-e2e-ca.crt
sudo update-ca-certificates >/dev/null
