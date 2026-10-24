# The variables proxy-deploy-e2e.yml's proxy-swap-load-e2e job sets, for entry.sh
export BLOT_HOST=blot.im
export PROXY_CANARY_HOST=preview-of-wireframe-on-david.blot.im
export PROXY_AUTOSSL_VOLUME=blot-e2e-auto-ssl
export PROXY_NODE_CONTAINER=blot-container-blue
export PROXY_SKIP_CERT_SWEEP=1
export E2E_ROOT=/tmp/proxy-e2e
export PROXY_ENV_FILE=$E2E_ROOT/proxy.env
export PROXY_ENV_FILE_BAD=$E2E_ROOT/proxy-unroutable-private-ip.env
export PROXY_CACHE_DIR=$E2E_ROOT/cache
export PROXY_LOG_DIR=$E2E_ROOT/logs
export PROXY_CERT_DIR=$E2E_ROOT/certs
export PROXY_GLOBAL_STATIC_DIR=$E2E_ROOT/global-static
