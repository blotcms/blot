#!/usr/bin/env bash
#
# The host side of a unit deploy, which blue-green.sh expects to find: the
# directories a unit mounts, unit-settings.env (the real numbers from
# scripts/deploy/constants.js, with this harness's directories and a cpu limit
# the runner can meet) and secrets.env. Run it after setup.sh, with E2E_ROOT,
# BLOT_HOST, PROXY_UNIT_SETTINGS and PROXY_SECRETS_ENV_FILE exported.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${E2E_ROOT:?}" "${BLOT_HOST:?}" "${PROXY_UNIT_SETTINGS:?}" "${PROXY_SECRETS_ENV_FILE:?}"

# the data directory is bound with rslave, which Docker accepts only from a
# shared mount
sudo mount --make-rshared /
sudo install -d -m 755 -o "$(id -u)" /run/blot
mkdir -p "$E2E_ROOT/data" "$E2E_ROOT/tmp"
node "$REPO_ROOT/scripts/deploy/unit-settings.js" > "$PROXY_UNIT_SETTINGS"
printf 'DATA_DIRECTORY_ON_SERVER=%s\nTMP_DIRECTORY=%s\nUNIT_CPUS=2\n' "$E2E_ROOT/data" "$E2E_ROOT/tmp" >> "$PROXY_UNIT_SETTINGS"
printf 'BLOT_HOST=%s\nBLOT_REVERSE_PROXY_URLS=http://127.0.0.1:8077\n' "$BLOT_HOST" > "$PROXY_SECRETS_ENV_FILE"
