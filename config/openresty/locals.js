// The values substituted into the OpenResty config templates in ./conf.
//
// Two generators render those templates and both get their locals from here:
//   baremetal()  config/openresty/build-config.js
//   container()  proxy/build/index.js
//
// Mustache renders a local that is missing as an empty string, so a template
// that starts reading a new variable must find it in BOTH sets. That is
// checked by ./tests/locals.js.

function required(env, name) {
  if (!env[name]) throw new Error(`${name} not set`);
  return env[name];
}

// Locals whose value comes from the environment the same way in both.
// cdn_ips is a list of addresses, fetched by the caller.
function common({ env, config, cdn_ips, node_ip, redis_host }) {
  // max file size for icloud uploads and webhooks bodies
  // nginx requires 'M' instead of 'MB' but unfortunately
  // node rawbody parser requires 'MB' instead of 'M'
  // so this maps '25MB' to '25M' for nginx
  const iCloud_max_body_size = `${config.icloud.maxFileSize / 1000000}M`;
  const webhooks_client_max_body_size = `${
    config.webhooks.client_max_body_size / 1000000
  }M`;

  return {
    disable_http2: env.DISABLE_HTTP2,
    node_ip,
    node_port: "8088",

    // The maximum size of icloud uploads
    iCloud_max_body_size,

    // The maximum size of webhooks bodies forwarded to the node server
    webhooks_client_max_body_size,

    // used in production by the node application container running inside docker
    // to communicate with the openresty cache purge endpoint on localhost
    openresty_instance_private_ip: env.OPENRESTY_INSTANCE_PRIVATE_IP,

    // used in production if we run multiple openresty instances at the same time
    server_label: env.SERVER_LABEL || "us",

    // remote config directory on the ec2 instance to which we will copy the config files
    config_directory: env.OPENRESTY_CONFIG_DIRECTORY || "/home/ec2-user/openresty",
    redis: { host: redis_host },

    // used only by the ci test runner since this path changes on github actions
    lua_package_path: env.LUA_PACKAGE_PATH,
    user: env.OPENRESTY_USER || "ec2-user",
    log_directory: env.OPENRESTY_LOG_DIRECTORY || "/var/instance-ssd/logs",

    // if you change the cache directory, you must also update the
    // script mount-instance-store.sh
    cache_directory: env.OPENRESTY_CACHE_DIRECTORY || "/var/instance-ssd/cache",
    ssl_certificate:
      env.SSL_CERTIFICATE || "/etc/ssl/private/letsencrypt-domain.pem",
    ssl_certificate_key:
      env.SSL_CERTIFICATE_KEY || "/etc/ssl/private/letsencrypt-domain.key",

    NETDATA_PASSWORD: env.NETDATA_PASSWORD,
    NETDATA_USER: env.NETDATA_USER,
    NETDATA_PORT: env.NETDATA_PORT,

    // BunnyCDN IPs for whitelisting from rate limiting
    cdn_ips: cdn_ips.map((ip) => ({ ip })),
  };
}

// The bare-metal host: paths are the real ones on the machine.
function baremetal({ env = process.env, config, cdn_ips }) {
  return {
    ...common({
      env,
      config,
      cdn_ips,
      node_ip: required(env, "NODE_SERVER_IP"),
      redis_host: required(env, "REDIS_IP"),
    }),
    host: "blot.im",
    blot_directory: config.blot_directory,
    blog_static_files_dir: config.blog_static_files_dir,
    global_static_files_dir: config.blot_directory + "/app/blog/static",
  };
}

// The values which can change without rebuilding the container image. nginx
// cannot read the environment, so the generated config carries ${NAME}
// placeholders and proxy/render-config.sh substitutes them (with envsubst)
// when the container starts. runtimeDefaults() is the value used when a
// variable is not set at runtime; it is written to defaults.env at build time.
//
// PROXY_UPSTREAM_*: host:port of the Node containers. The upstream groups in
// http.conf keep their weights and failover roles; only where each container
// is changes. GREEN is the master (webhooks, /clients), BLUE serves the
// dashboard and is the failover for the others, YELLOW serves blogs.
const placeholder = (name) => "${" + name + "}";

// What each runtime variable is when it is not set at runtime. Build-time
// REDIS_IP, SERVER_LABEL and OPENRESTY_RESOLVER still work as defaults.
function runtimeDefaults(env = process.env) {
  return {
    PROXY_REDIS_HOST: env.REDIS_IP || "127.0.0.1",
    PROXY_SERVER_LABEL: env.SERVER_LABEL || "us",
    PROXY_PRIVATE_IP: env.OPENRESTY_INSTANCE_PRIVATE_IP || "127.0.0.1",
    PROXY_RESOLVER: env.OPENRESTY_RESOLVER || "8.8.8.8 ipv6=off",
    PROXY_UPSTREAM_GREEN: "127.0.0.1:8089",
    PROXY_UPSTREAM_BLUE: "127.0.0.1:8088",
    PROXY_UPSTREAM_YELLOW: "127.0.0.1:8090",
  };
}

// The container image. Host paths from require("config") would bake the
// generator's filesystem into the image, so these come from the environment.
function container({ env = process.env, config }) {
  return {
    ...common({
      env,
      config,
      // the Bunny edge list is an include file the container writes at start
      // (proxy/build/sync-config.js, proxy/render-config.sh)
      cdn_ips: [],
      node_ip: undefined,
      redis_host: placeholder("PROXY_REDIS_HOST"),
    }),

    server_label: placeholder("PROXY_SERVER_LABEL"),

    // Address of the extra :8077 listener for the cache purge endpoint. The
    // Node containers sit on a Docker bridge and cannot reach the host's
    // 127.0.0.1:80, so they purge through the host's private address instead
    // (BLOT_REVERSE_PROXY_URLS). Loopback when unset: nothing else can use it.
    openresty_instance_private_ip: placeholder("PROXY_PRIVATE_IP"),

    resolver: placeholder("PROXY_RESOLVER"),

    // Base domain the generated virtual hosts are built from. This is a
    // build-time value; the BLOT_HOST passed to `docker run` only affects
    // certificate handling in entrypoint.sh, not the already-generated config.
    host: env.BLOT_HOST || "blot.im",
    blot_directory: env.BLOT_DIRECTORY || "/var/www/blot",

    // The container does not mount the blog static tree, so try_files finds
    // nothing and every cdn. request that reaches it falls through to
    // @cdn_node (blot_node), as it does on bare-metal for a file the disk
    // does not have. Set these and mount the tree to serve from disk.
    blog_static_files_dir:
      env.BLOG_STATIC_FILES_DIR || "/var/www/blot/data/static",
    global_static_files_dir:
      env.GLOBAL_STATIC_FILES_DIR || "/var/www/blot/app/blog/static",

    // ACME directory URL lua-resty-auto-ssl uses to issue custom-domain
    // certificates on demand. Production default is Let's Encrypt; CI points
    // this at a Pebble test server (see .github/workflows/integration.yml).
    acme_ca: env.ACME_CA || "https://acme-v02.api.letsencrypt.org/directory",

    // Add `reuseport` to the default server's listen directives so a second
    // container can bind the same :80/:443 during a blue/green handover
    // (proxy/deploy/blue-green.sh). Set ENABLE_REUSEPORT=false where the
    // generated config runs under a single process only.
    reuseport: env.ENABLE_REUSEPORT !== "false",

    // Send the error/access logs to stderr/stdout so `docker logs` works.
    // Set LOG_TO_STDOUT=false for the bare-metal path, which rotates files.
    log_to_stdout: env.LOG_TO_STDOUT !== "false",
  };
}

module.exports = { baremetal, container, runtimeDefaults };
