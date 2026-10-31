// The values substituted into the OpenResty config templates in proxy/config,
// used by proxy/build/index.js. Tested by proxy/tests/locals.js.
//
// Mustache renders a local that is missing as an empty string, so a template
// that starts reading a new variable must find it here. That is checked by
// proxy/tests/locals.js.

// The values which can change without rebuilding the container image. nginx
// cannot read the environment, so the generated config carries ${NAME}
// placeholders and proxy/render-config.sh substitutes them (with envsubst)
// when the container starts. runtimeDefaults() is the value used when a
// variable is not set at runtime; it is written to defaults.env at build time.
//
// PROXY_ACME_CA: the ACME directory custom-domain certificates are issued
// from. Let's Encrypt production unless set (e.g. its staging directory, to
// try issuance without rate limits; a Pebble server in CI).
//
// PROXY_UNIT: which proxy container this is (blue or green), logged as unit= at
// the end of each access log line. The deploy scripts set it from the
// container's name; "-" when unset.
//
// PROXY_UPSTREAM_MODE: "unit", the only mode. The proxy shares a container with
// its own two Node processes (#2119). It takes four addresses, normally Unix
// sockets in the /run/blot both units share: PROXY_UNIT_MAIN and
// PROXY_UNIT_WORKER are this unit's main process (blogs, dashboard reads) and
// worker child (/clients, writes, webhooks); PROXY_PEER_MAIN and
// PROXY_PEER_WORKER are the other unit's, used as `backup`.
//
// The upstream groups in http.conf read six PROXY_*_PRIMARY / PROXY_*_BACKUP
// placeholders. render-config.sh always sets them from the mode and the
// addresses above, so a value given for one of the six is ignored; their
// defaults here are the unit-mode values.
const placeholder = (name) => "${" + name + "}";

const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";

// What each runtime variable is when it is not set at runtime. Build-time
// REDIS_IP, SERVER_LABEL and OPENRESTY_RESOLVER still work as defaults.
function runtimeDefaults(env = process.env) {
  return {
    PROXY_REDIS_HOST: env.REDIS_IP || "127.0.0.1",
    PROXY_SERVER_LABEL: env.SERVER_LABEL || "us",
    PROXY_PRIVATE_IP: env.OPENRESTY_INSTANCE_PRIVATE_IP || "127.0.0.1",
    PROXY_RESOLVER: env.OPENRESTY_RESOLVER || "8.8.8.8 ipv6=off",
    PROXY_ACME_CA: env.ACME_CA || LETS_ENCRYPT,
    PROXY_UNIT: "-",
    PROXY_UPSTREAM_MODE: "unit",
    PROXY_UNIT_MAIN: "unix:/run/blot/blue-a.sock",
    PROXY_UNIT_WORKER: "unix:/run/blot/blue-b.sock",
    PROXY_PEER_MAIN: "unix:/run/blot/green-a.sock",
    PROXY_PEER_WORKER: "unix:/run/blot/green-b.sock",
    PROXY_NODE_PRIMARY: "unix:/run/blot/blue-b.sock",
    PROXY_NODE_BACKUP: "unix:/run/blot/green-b.sock",
    PROXY_BLOGS_PRIMARY: "unix:/run/blot/blue-a.sock",
    PROXY_BLOGS_BACKUP: "unix:/run/blot/green-a.sock",
    PROXY_DASHBOARD_PRIMARY: "unix:/run/blot/blue-a.sock",
    PROXY_DASHBOARD_BACKUP: "unix:/run/blot/green-a.sock",
  };
}

// The container image. Host paths from require("config") would bake the
// generator's filesystem into the image, so these come from the environment.
function container({ env = process.env, config }) {
  // max file size for webhook bodies. nginx requires 'M' instead of 'MB' but
  // unfortunately the node rawbody parser requires 'MB' instead of 'M', so
  // this maps '25MB' to '25M' for nginx
  const webhooks_client_max_body_size = `${
    config.webhooks.client_max_body_size / 1000000
  }M`;

  return {
    disable_http2: env.DISABLE_HTTP2,

    // The maximum size of webhooks bodies forwarded to the node server
    webhooks_client_max_body_size,

    config_directory:
      env.OPENRESTY_CONFIG_DIRECTORY || "/home/ec2-user/openresty",

    // used only by the ci test runner since this path changes on github actions
    lua_package_path: env.LUA_PACKAGE_PATH,
    user: env.OPENRESTY_USER || "ec2-user",
    log_directory: env.OPENRESTY_LOG_DIRECTORY || "/var/instance-ssd/logs",
    cache_directory: env.OPENRESTY_CACHE_DIRECTORY || "/var/instance-ssd/cache",
    ssl_certificate:
      env.SSL_CERTIFICATE || "/etc/ssl/private/letsencrypt-domain.pem",
    ssl_certificate_key:
      env.SSL_CERTIFICATE_KEY || "/etc/ssl/private/letsencrypt-domain.key",

    redis: { host: placeholder("PROXY_REDIS_HOST") },

    server_label: placeholder("PROXY_SERVER_LABEL"),

    // Address of the extra :8077 listener for the cache purge endpoint. Node
    // purges through it (BLOT_REVERSE_PROXY_URLS). Units run with host
    // networking, so this is loopback in production. Loopback when unset:
    // nothing else can use it.
    openresty_instance_private_ip: placeholder("PROXY_PRIVATE_IP"),

    resolver: placeholder("PROXY_RESOLVER"),

    // Base domain the generated virtual hosts are built from. This is a
    // build-time value; the BLOT_HOST passed to `docker run` only affects
    // certificate handling in entrypoint.sh, not the already-generated config.
    host: env.BLOT_HOST || "blot.im",

    global_static_files_dir:
      env.GLOBAL_STATIC_FILES_DIR || "/var/www/blot/app/blog/static",

    // ACME directory URL lua-resty-auto-ssl uses to issue custom-domain
    // certificates on demand: a runtime setting (PROXY_ACME_CA), Let's Encrypt
    // production unless set. A build-time ACME_CA still works as the default.
    acme_ca: placeholder("PROXY_ACME_CA"),

    // Add `reuseport` to the default server's listen directives so a second
    // container can bind the same :80/:443 during a blue/green handover
    // (proxy/deploy/blue-green.sh). Set ENABLE_REUSEPORT=false where the
    // generated config runs under a single process only.
    reuseport: env.ENABLE_REUSEPORT !== "false",

    // Send the error/access logs to stderr/stdout so `docker logs` works.
    // Set LOG_TO_STDOUT=false to write files under OPENRESTY_LOG_DIRECTORY
    // instead (the production image does this, so the host's log rotation
    // and the log-reading scripts keep working).
    log_to_stdout: env.LOG_TO_STDOUT !== "false",
  };
}

module.exports = { container, runtimeDefaults };
