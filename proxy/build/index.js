const mustache = require("mustache");
const config = require("config");
const fs = require("fs-extra");
const path = require("path");
const child_process = require("child_process");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) return; // fine in CI - env comes from the runner
  try {
    const envContent = fs.readFileSync(envPath, "utf8");
    const envVars = envContent
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .reduce((vars, line) => {
        const [key, ...valueParts] = line.split("=");
        const value = valueParts.join("=").trim();
        if (key && value) {
          vars[key.trim()] = value.replace(/^["']|["']$/g, "");
        }
        return vars;
      }, {});

    // Do not clobber values already exported by the caller (e.g. the
    // container paths that proxy/build/build.sh sets). .env only fills gaps.
    for (const [key, value] of Object.entries(envVars)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    console.error("Error reading .env file:", error);
  }
}

loadEnvFile();

function fetchCDNIPs() {
  const bunnyCDNIPURL = "https://bunnycdn.com/api/system/edgeserverlist";
  const result = child_process.spawnSync("curl", [
    "-sS",
    "--max-time",
    "15",
    bunnyCDNIPURL,
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `curl exited ${result.status}`);
  }
  const ips = JSON.parse(result.stdout.toString());
  if (!Array.isArray(ips) || !ips.length) {
    throw new Error("No CDN IPs fetched");
  }
  return ips;
}

function loadCDNIPs() {
  // Match config/openresty/build-config.js: production/local generates fetch
  // the Bunny edge list (required for the rate-limit whitelist). CI sets
  // FETCH_CDN_IPS=false so the proxy image build does not depend on Bunny.
  if (process.env.FETCH_CDN_IPS === "false") return [];
  return fetchCDNIPs();
}

const NETDATA_USER = process.env.NETDATA_USER;
const NETDATA_PASSWORD = process.env.NETDATA_PASSWORD;
const NETDATA_PORT = process.env.NETDATA_PORT;

const NODE_SERVER_IP = process.env.NODE_SERVER_IP;
const REDIS_IP = process.env.REDIS_IP;

if (!NODE_SERVER_IP) throw new Error("NODE_SERVER_IP not set");
if (!REDIS_IP) throw new Error("REDIS_IP not set");

const OUTPUT = __dirname + "/data/latest";
const PREVIOUS = OUTPUT + "-previous-" + Date.now();
// proxy/config is a generated copy of config/openresty/conf with
// container-only patches from ./sync-config.js. Always refresh it so a
// direct `node proxy/build/index.js` cannot build from a stale fork.
require("./sync-config").sync();
const CONFIG_DIRECTORY = path.resolve(__dirname, "../config");

const template = fs.readFileSync(`${CONFIG_DIRECTORY}/server.conf`, "utf8");
const partials = {};

// remote config directory on the ec2 instance to which we will copy the config files
const config_directory =
  process.env.OPENRESTY_CONFIG_DIRECTORY || "/home/ec2-user/openresty";

// max file size for icloud uploads and webhooks bodies
// nginx requires 'M' instead of 'MB' but unfortunately
// node rawbody parser requires 'MB' instead of 'M'
// so this maps '25MB' to '25M' for nginx
const iCloud_max_body_size = `${config.icloud.maxFileSize / 1000000}M`;
const webhooks_client_max_body_size = `${
  config.webhooks.client_max_body_size / 1000000
}M`;

const locals = {
  // Base domain the generated virtual hosts are built from. This is a
  // build-time value; the BLOT_HOST passed to `docker run` only affects
  // certificate handling in entrypoint.sh, not the already-generated config.
  host: process.env.BLOT_HOST || "blot.im",
  blot_directory: process.env.BLOT_DIRECTORY || "/var/www/blot",
  // Host paths from require("config") would bake the generator's filesystem
  // into the image. The container does not mount the blog static tree yet;
  // try_files falls through to @cdn_node. Override with env when it does.
  blog_static_files_dir:
    process.env.BLOG_STATIC_FILES_DIR || "/var/www/blot/data/static",
  global_static_files_dir:
    process.env.GLOBAL_STATIC_FILES_DIR || "/var/www/blot/app/blog/static",
  disable_http2: process.env.DISABLE_HTTP2,
  node_ip: NODE_SERVER_IP,
  node_port: "8088",

  // The maximum size of icloud uploads
  iCloud_max_body_size,

  // The maximum size of webhooks bodies forwarded to the node server
  webhooks_client_max_body_size,

  // used in production by the node application container running inside docker
  // to communicate with the openresty cache purge endpoint on localhost
  openresty_instance_private_ip: process.env.OPENRESTY_INSTANCE_PRIVATE_IP,

  // used in production if we run multiple openresty instances at the same time
  server_label: process.env.SERVER_LABEL || "us",

  config_directory,
  redis: { host: REDIS_IP },

  // used only by the ci test runner since this path changes on github actions
  lua_package_path: process.env.LUA_PACKAGE_PATH,
  user: process.env.OPENRESTY_USER || "ec2-user",
  log_directory:
    process.env.OPENRESTY_LOG_DIRECTORY || "/var/instance-ssd/logs",

  // if you change the cache directory, you must also update the
  // script mount-instance-store.sh
  cache_directory:
    process.env.OPENRESTY_CACHE_DIRECTORY || "/var/instance-ssd/cache",
  ssl_certificate:
    process.env.SSL_CERTIFICATE || "/etc/ssl/private/letsencrypt-domain.pem",
  ssl_certificate_key:
    process.env.SSL_CERTIFICATE_KEY ||
    "/etc/ssl/private/letsencrypt-domain.key",

  // ACME directory URL lua-resty-auto-ssl uses to issue custom-domain
  // certificates on demand. Production default is Let's Encrypt; CI points
  // this at a Pebble test server (see .github/workflows/integration.yml).
  acme_ca:
    process.env.ACME_CA || "https://acme-v02.api.letsencrypt.org/directory",

  // DNS resolver OpenResty uses for OCSP stapling and to reach the ACME
  // server. A container on a user-defined Docker network wants 127.0.0.11.
  resolver: process.env.OPENRESTY_RESOLVER || "8.8.8.8 ipv6=off",

  // Add `reuseport` to the default server's listen directives so a second
  // container can bind the same :80/:443 during a blue/green handover
  // (proxy/deploy/blue-green.sh). Set ENABLE_REUSEPORT=false where the
  // generated config runs under a single process only.
  reuseport: process.env.ENABLE_REUSEPORT !== "false",

  // Send the error/access logs to stderr/stdout so `docker logs` works.
  // Set LOG_TO_STDOUT=false for the bare-metal path, which rotates files.
  log_to_stdout: process.env.LOG_TO_STDOUT !== "false",

  NETDATA_PASSWORD,
  NETDATA_USER,
  NETDATA_PORT,

  // BunnyCDN edge IPs, whitelisted from rate-limits in http.conf. Fetched
  // by default (same as config/openresty/build-config.js) so a deployable
  // image does not rate-limit the CDN. CI sets FETCH_CDN_IPS=false.
  cdn_ips: loadCDNIPs().map((ip) => ({ ip })),
};

// move the previous contents of the data directory to a backup
// so we can compare the new contents with the old
if (fs.existsSync(OUTPUT)) fs.moveSync(OUTPUT, PREVIOUS, { overwrite: true });

fs.emptyDirSync(OUTPUT);

fs.copySync(path.resolve(__dirname, "../html"), `${OUTPUT}/html`);

fs.readdirSync(CONFIG_DIRECTORY).forEach((file) => {
  // copy lua files to data directory so they are available to nginx
  if (file.endsWith(".lua")) {
    fs.copySync(CONFIG_DIRECTORY + "/" + file, OUTPUT + "/" + file);
  }

  if (!file.endsWith(".conf")) return;

  partials[file] = fs.readFileSync(CONFIG_DIRECTORY + "/" + file, "utf8");
});

const warning = `

# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# !!!!!!!!!!!   WARNING                                   !!!!!!!!!!!
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

# Do not edit this file directly

# This file was generated by proxy/build/index.js from config/openresty
# (canonical) after proxy/build/sync-config.js applied container adaptations.
# Edit config/openresty/conf or proxy/build/sync-config.js, then re-run
# proxy/build/build.sh. Do not edit proxy/config by hand.

# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# !!!!!!!!!!!   WARNING                                   !!!!!!!!!!!
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

`;

const result = mustache.render(template, locals, partials);

fs.outputFileSync(OUTPUT + "/openresty.conf", warning + result);

// used by the proxy-tests ci action on github
if (process.argv.includes("--skip-confirmation")) {
  console.log("Build complete");
  return process.exit(0);
}

// compare the new contents with the old
const diff = child_process.spawnSync(
  "diff",
  ["--color", "-r", PREVIOUS, OUTPUT],
  { stdio: "inherit" }
);

if (diff.error) {
  console.error(diff.error);
} else {
  // ask the user to confirm the changes
  // if y, exit with success
  // if n, restore the previous contents to the OUTPUT directory
  // and remove the PREVIOUS directory
  // if anything else, ask the user to confirm again

  const readline = require("readline");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = () => {
    rl.question("Do you want to keep these changes? [y/n] ", (answer) => {
      if (answer === "y") {
        console.log("Changes kept. Build complete");
        rl.close();
      } else if (answer === "n") {
        console.log("Changes discarded");
        fs.removeSync(OUTPUT);
        fs.moveSync(PREVIOUS, OUTPUT);
        fs.removeSync(PREVIOUS);
        console.log("Done");
        rl.close();
        // exit with failure
        process.exit(1);
      } else {
        console.log("Please answer 'y' or 'n'");
        question();
      }
    });
  };

  question();
}
