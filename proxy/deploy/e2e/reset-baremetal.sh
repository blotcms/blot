#!/usr/bin/env bash
#
# Between scenarios in .github/workflows/proxy-deploy-e2e.yml: remove any
# leftover blot-proxy-* container and put bare-metal back to a fresh,
# enabled, serving state, the precondition cutover-from-baremetal.sh's
# preflight requires.
set -euo pipefail

BLOT_HOST="${BLOT_HOST:?}"

for n in blot-proxy-blue blot-proxy-green; do
  docker rm -f "$n" >/dev/null 2>&1 || true
done

sudo systemctl enable --now openresty

for i in $(seq 1 60); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    --connect-to "$BLOT_HOST:443:127.0.0.1:443" "https://$BLOT_HOST/" 2>/dev/null || echo 000)
  [ "$code" = 200 ] && exit 0
  sleep 1
done
echo "bare-metal OpenResty never came back to serving 200" >&2
docker logs blot-e2e-baremetal >&2 || true
exit 1
