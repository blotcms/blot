// The request corpus run against both configs by capture.js. Each entry is
// self-contained (scheme/host/path/method); capture.js records the same
// CAPTURED_HEADERS (lib.js) for each one and diff.js compares the two runs.
//
// `sanity` is an optional independent assertion (checked against BOTH
// captures individually, not against each other) - it exists so a mistake in
// this corpus (e.g. a typo'd path that stops matching a location block)
// shows up as a loud failure instead of both sides quietly agreeing on the
// wrong thing. It is not a substitute for the cross-config diff.
//
// Hosts are all under blot.im because both configs generate that as `host`
// here: the bare-metal generator (config/openresty/build-config.js) always
// uses "blot.im" (config/openresty/locals.js's baremetal() does not read
// BLOT_HOST), so proxy/differential/run.sh builds the container side with
// BLOT_HOST=blot.im too, to keep the two configs' virtual hosts identical.
const BLOCKED_PATHS = [
  // A sample across blot-blogs.conf's rule families - not exhaustive (that
  // file has ~80 location blocks), just enough to catch a rule that behaves
  // differently between the two configs.
  "/.env",
  "/.env.production",
  "/.git/config",
  "/.aws/credentials",
  "/id_rsa",
  "/wp-admin/",
  "/wp-content/plugins/x/wp-json.php", // wp- anywhere in the path
  "/actuator/health",
  "/graphql",
  "/metrics",
  "/vendor/composer/autoload.php", // /vendor/ directory rule -> 403
  "/index.php", // *.php -> 403
  "/docker-compose.yml",
  "/config.json",
];

const corpus = [
  // site host (blot-site.conf), https only + the :80 -> :443 redirect
  { name: "site / over https", scheme: "https", host: "blot.im", path: "/", sanity: { status: 200 } },
  { name: "site / over http redirects to https", scheme: "http", host: "blot.im", path: "/", sanity: { status: 301, locationStartsWith: "https://blot.im" } },
  { name: "site /health", scheme: "https", host: "blot.im", path: "/health", sanity: { status: 200 } },

  // blog subdomain (blot-blogs.conf, wildcard vhost)
  { name: "blog / over http", scheme: "http", host: "someblog.blot.im", path: "/", sanity: { status: 200 } },
  { name: "blog / over https", scheme: "https", host: "someblog.blot.im", path: "/", sanity: { status: 200 } },
  { name: "blog /health", scheme: "http", host: "someblog.blot.im", path: "/health", sanity: { status: 200 } },
  { name: "blog /random bypasses cache", scheme: "http", host: "someblog.blot.im", path: "/random", sanity: { status: 200 } },

  // custom domain (blot-blogs.conf, default_server)
  { name: "custom domain / over http", scheme: "http", host: "a-custom-domain.example", path: "/", sanity: { status: 200 } },
  { name: "custom domain / over https", scheme: "https", host: "a-custom-domain.example", path: "/", sanity: { status: 200 } },

  // cdn. host - neither config here mounts the static file tree
  // (blotcms/blot#1941's "Serve cdn. files from disk" item), so both fall
  // through to @cdn_node identically: this corpus can't tell the Cache-Control
  // + CORS headers are missing from that fallback, only that both configs are
  // equally missing them.
  { name: "cdn. root redirects to blot.im", scheme: "http", host: "cdn.blot.im", path: "/", sanity: { status: 301, locationStartsWith: "https://blot.im" } },
  { name: "cdn. file falls through to node", scheme: "http", host: "cdn.blot.im", path: "/some/file.png", sanity: { status: 200 } },

  // webhooks. host (SSE relay to the green/master upstream) - only a :443
  // server is defined.
  { name: "webhooks. over https", scheme: "https", host: "webhooks.blot.im", path: "/", sanity: { status: 200 } },

  // upstream error passthrough (both configs proxy_pass to the same stub)
  { name: "upstream 503 passes through", scheme: "http", host: "someblog.blot.im", path: "/unavailable", sanity: { status: 503 } },
  { name: "upstream 500 (offline page body, status preserved)", scheme: "http", host: "someblog.blot.im", path: "/boom", sanity: { status: 500 } },

  ...BLOCKED_PATHS.map((path) => ({
    name: `blocked: ${path}`,
    scheme: "http",
    host: "someblog.blot.im",
    path,
    // Every blocked path here returns either 444 (connection closed, "000"
    // in this harness - see lib.js) or 403; never 200.
    sanity: { statusNot: 200 },
  })),
];

// Blot-Cache MISS -> HIT: two sequential requests to the same cache key.
// Captured separately from `corpus` because it needs two correlated
// requests, not one.
const cacheSequence = {
  name: "Blot-Cache MISS then HIT",
  scheme: "http",
  host: "someblog.blot.im",
  path: "/cache-me/differential",
};

module.exports = { corpus, cacheSequence };
