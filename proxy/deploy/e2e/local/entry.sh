#!/usr/bin/env bash
#
# Runs inside the container of local/Dockerfile (started by local.sh): its own
# Docker daemon, the images loaded into it, then the same steps as the
# unit-swap-load-e2e job in .github/workflows/proxy-deploy-e2e.yml.
set -euo pipefail

REPO=/repo
dockerd > /var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { cat /var/log/dockerd.log; exit 1; }
# containers a killed earlier run left in the daemon's volume
docker ps -aq | xargs -r docker rm -f >/dev/null
docker volume ls -q | xargs -r docker volume rm -f >/dev/null
docker load -i /images/images.tar >/dev/null

. "$REPO/proxy/deploy/e2e/local/env.sh"

STUB_JS="$REPO/proxy/deploy/e2e/swap-load-stub.js" bash "$REPO/proxy/deploy/e2e/setup.sh"
bash "$REPO/proxy/deploy/e2e/unit-setup.sh"
status=0
bash "$REPO/proxy/deploy/e2e/swap-load.sh" || status=$?
if [ "$status" != 0 ]; then
  for c in blot-blue blot-green blot-blue-airlock blot-green-airlock blot-e2e-stub; do echo "=== $c ==="; docker logs --tail 40 "$c" 2>&1 || true; done
  echo "=== error.log ==="; tail -n 60 "$PROXY_LOG_DIR/error.log" || true
fi
exit "$status"
