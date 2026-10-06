#!/usr/bin/env bash
set -euo pipefail

BLOT_HOST=${1:-local.blot}

# project root = two levels up from this script
PROJ_ROOT="$(cd "$(dirname "$0")/../.."; pwd)"
CERT_DIR="$PROJ_ROOT/data/ssl"
CRT="$CERT_DIR/certs/wildcard.crt"
KEY="$CERT_DIR/private/wildcard.key"

mkdir -p "$CERT_DIR/certs"
mkdir -p "$CERT_DIR/private"

# Worktree preview hosts (scripts/development/preview.sh)
PREVIEW_HOSTS=(a-local.blot b-local.blot c-local.blot d-local.blot e-local.blot)
PREVIEW_SANS=()
for h in "${PREVIEW_HOSTS[@]}"; do PREVIEW_SANS+=("$h" "*.$h"); done

# skip if both files exist, are non-empty, and cover the preview hosts
if [[ -s "$CRT" && -s "$KEY" ]]; then
  if command -v openssl >/dev/null 2>&1 &&
    ! openssl x509 -in "$CRT" -noout -text | grep -q "DNS:\*\.e-local\.blot"; then
    echo "[start] Existing dev certificate lacks worktree preview hosts; regenerating"
  else
    echo "[start] Existing dev certificates found"
    exit 0
  fi
fi

# otherwise, create them
if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert not installed. Install with: brew install mkcert nss"
  exit 1
fi

echo "[start] Generating new development TLS certificates with mkcert..."
mkcert -install

mkcert -key-file "$KEY" -cert-file "$CRT" \
  "$BLOT_HOST" "*.$BLOT_HOST" "${PREVIEW_SANS[@]}"

chmod 0644 "$CRT" || true
chmod 0600 "$KEY" || true

echo "[start] Certificates generated"


# TODO
# we need to install a newer version of fail2ban (e.g. 1.1.0) from source
# the old version has a bug which doesn't purge the db of old bans
# we need to remove any existing installation and install the latest version from source to fix this

