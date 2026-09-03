#!/usr/bin/env bash
# Generate the locally-trusted wildcard TLS certificate the OpenResty reverse
# proxy needs for https://local.blot and https://*.local.blot, and trust the
# mkcert root CA in both the system store and the NSS store used by Chrome (so
# browser-based testing shows a valid certificate). Idempotent and non-blocking.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CAROOT="$(mkcert -CAROOT)"

mkcert -install >/dev/null 2>&1 || true

# wildcard.crt / wildcard.key consumed by config/openresty (see setup.sh).
bash "$REPO_DIR/config/openresty/setup.sh" "${BLOT_HOST:-local.blot}"

# Trust the mkcert root CA in Chrome's NSS database for computer-use testing.
# Wrapped in `timeout` because certutil can block on the DB lock if Chrome is
# already running, and skipped entirely once the CA is present.
NSSDB="$HOME/.pki/nssdb"
if command -v certutil >/dev/null 2>&1; then
  if timeout 20 certutil -d "sql:$NSSDB" -L 2>/dev/null | grep -q "mkcert-root"; then
    : # already trusted
  else
    mkdir -p "$NSSDB"
    [ -f "$NSSDB/cert9.db" ] || timeout 20 certutil -d "sql:$NSSDB" -N --empty-password >/dev/null 2>&1 || true
    timeout 20 certutil -d "sql:$NSSDB" -A -t "C,," -n "mkcert-root" \
      -i "$CAROOT/rootCA.pem" >/dev/null 2>&1 || true
  fi
fi
