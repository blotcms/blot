// Each check takes a context and resolves to a short detail string when it
// passes, or throws when it doesn't. See ./index.js for how they are run.
//
// context: { config, redis, expectedRelease }
//   redis - a connected node-redis client (dedicated to this run)

const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// A blog folder on disk is data/blogs/{blogID}. Deleted blogs and blogs that
// never synced mean the two won't match exactly, so this is a loose floor:
// a wrong, stale or empty mount misses most blogs, not a few. The real ratio
// is always in the report - tighten this once we've seen it in prod.
const MIN_BLOGS_WITH_FOLDER = 0.5;

// An absolute floor only: the data disk is meant to fill up with blogs, so
// how full it is belongs in monitoring, not a deploy gate.
const MIN_FREE_BYTES = 2 * 1024 ** 3; // 2GiB

// The status page (https://status.blot.im) checks this same blog. Rendering
// it exercises redis, the blogs mount, the templates and the blog server in
// one request. Preview subdomains are exempt from the HTTPS redirect, so
// plain HTTP to the container works.
//
// The request goes straight to this container's own node process on
// 127.0.0.1 (this script runs inside it via `docker exec`), never through
// the OpenResty proxy: its cache or another container could otherwise
// answer, and the check would pass for the wrong container.
const CANARY_HANDLE = "david";
const CANARY_TEMPLATE = "wireframe";

// Environment variables the app can't do its job without.
const REQUIRED_ENV = [
  "BLOT_SESSION_SECRET",
  "BLOT_STRIPE_SECRET",
  "BLOT_STRIPE_WEBHOOK_SECRET",
  "BLOT_AIRLOCK_BROWSER_URL",
  "BLOT_AIRLOCK_PROXY_URL",
];

function request({ url, host, headers = {}, timeout = 8000, options = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: { Host: host, ...headers }, timeout, ...options },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeout}ms`)));
    req.on("error", reject);
  });
}

async function redisRoundTrip({ redis }) {
  await redis.ping();
  // PING succeeds against a read-only replica; a write doesn't.
  const key = `deploy-verify:${process.pid}:${Date.now()}`;
  await redis.set(key, "ok", { EX: 30 });
  const value = await redis.get(key);
  await redis.del(key);
  if (value !== "ok") throw new Error(`wrote "ok", read back ${JSON.stringify(value)}`);
  return "ping, write and read succeeded";
}

async function dataDirectory({ config, redis }) {
  const blogsDir = config.blog_folder_dir;
  let entries;
  try {
    entries = await fs.readdir(blogsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read ${blogsDir}: ${err.message}`);
  }

  const folders = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const blogIDs = await redis.sMembers("blogs");

  if (!blogIDs.length) throw new Error("redis has no blogs");
  if (!folders.size) throw new Error(`${blogsDir} has no blog folders`);

  const withFolder = blogIDs.filter((id) => folders.has(id)).length;
  const ratio = withFolder / blogIDs.length;
  const summary = `${withFolder}/${blogIDs.length} blogs in redis have a folder, ${folders.size} folders on disk`;

  if (ratio < MIN_BLOGS_WITH_FOLDER) {
    throw new Error(`${summary} (need ${MIN_BLOGS_WITH_FOLDER * 100}%) - wrong or stale data mount?`);
  }
  return summary;
}

async function dataDirectoryWritable({ config }) {
  // The mount is owned by the host; the app runs as uid 1000.
  await fs.mkdir(config.tmp_directory, { recursive: true });
  const file = path.join(config.tmp_directory, `deploy-verify-${process.pid}`);
  await fs.writeFile(file, "ok");
  await fs.unlink(file);
  return `${config.tmp_directory} is writable`;
}

async function diskSpace({ config }) {
  const stats = await fs.statfs(config.data_directory);
  const free = stats.bavail * stats.bsize;
  const ratio = free / (stats.blocks * stats.bsize);
  const summary = `${(free / 1024 ** 3).toFixed(1)}GiB free (${(ratio * 100).toFixed(0)}%)`;
  if (free < MIN_FREE_BYTES) {
    throw new Error(`${summary} on the data mount`);
  }
  return summary;
}

async function binary(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
    return stdout.split("\n")[0].trim();
  } catch (err) {
    throw new Error(`${command} is not runnable: ${err.message}`);
  }
}

const pandoc = () => binary("pandoc", ["--version"]);
const git = () => binary("git", ["--version"]);

// Decodes a real HEIC (the same photo the img converter's spec uses; app
// tests aren't in the production image, so it's copied here). Advertised
// format support isn't enough: a missing or broken HEVC decoder still lists
// heif as an input.
async function sharpWorks() {
  const sharp = require("sharp");
  const fixture = path.join(__dirname, "fixtures", "car.heic");
  const { width, height } = await sharp(fixture).jpeg().toBuffer().then((buffer) =>
    sharp(buffer).metadata()
  );
  if (!width || !height) throw new Error("decoded HEIC has no dimensions");
  return `sharp decoded a HEIC to a ${width}x${height} JPEG`;
}

async function requiredEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`unset: ${missing.join(", ")}`);
  return `${REQUIRED_ENV.length} variables set`;
}

async function releaseID({ expectedRelease }) {
  if (!expectedRelease) throw new Error("no expected release ID was passed");
  if (process.env.BLOT_RELEASE_ID !== expectedRelease) {
    throw new Error(
      `container is ${process.env.BLOT_RELEASE_ID}, deploying ${expectedRelease}`
    );
  }
  return expectedRelease;
}

// Deliberately not the degrade-gracefully view of the airlock the app takes
// at runtime: a container that can't reach it should not go live.
async function airlock({ config }) {
  const { browser_url, proxy } = config.airlock;
  if (!browser_url || !proxy) throw new Error("airlock URLs are not configured");

  const res = await request({
    url: new URL("/json/version", browser_url).href,
    host: new URL(browser_url).host,
  }).catch((err) => {
    throw new Error(`browser ${browser_url} unreachable: ${err.message}`);
  });
  if (res.status !== 200) throw new Error(`browser ${browser_url} returned ${res.status}`);

  // A forward-proxy request (like `curl -x`) for the special host tinyproxy
  // answers itself, so it needs no egress - the same probe the airlock's own
  // HEALTHCHECK uses.
  const { hostname, port } = new URL(proxy);
  const proxied = await request({
    url: "http://tinyproxy.stats/",
    host: "tinyproxy.stats",
    options: { hostname, port, path: "http://tinyproxy.stats/" },
  }).catch((err) => {
    throw new Error(`proxy ${proxy} unreachable: ${err.message}`);
  });
  if (proxied.status !== 200) throw new Error(`proxy ${proxy} returned ${proxied.status}`);

  return "browser and proxy reachable";
}

async function canaryBlog({ config }) {
  const host = `preview-of-${CANARY_TEMPLATE}-on-${CANARY_HANDLE}.${config.host}`;
  const res = await request({ url: `http://127.0.0.1:${config.port}/`, host });
  if (res.status !== 200) throw new Error(`${host} returned ${res.status}`);
  if (!/<html/i.test(res.body) || !/<\/html>/i.test(res.body) || res.body.length < 500) {
    throw new Error(`${host} returned a ${res.body.length} byte body that isn't a complete HTML page`);
  }
  return `${host} rendered (${res.body.length} bytes)`;
}

async function loginPage({ config }) {
  const res = await request({
    url: `http://127.0.0.1:${config.port}/sites/log-in`,
    host: config.host,
    headers: { "X-Forwarded-Proto": "https" },
  });
  if (res.status !== 200) throw new Error(`/sites/log-in returned ${res.status}`);
  return "dashboard log-in page rendered";
}

module.exports = [
  { name: "release ID", run: releaseID },
  { name: "redis read/write", run: redisRoundTrip },
  { name: "blog folders match redis", run: dataDirectory },
  { name: "data directory writable", run: dataDirectoryWritable },
  { name: "disk space", run: diskSpace },
  { name: "pandoc", run: pandoc },
  { name: "git", run: git },
  { name: "sharp", run: sharpWorks },
  { name: "required environment", run: requiredEnv },
  { name: "airlock", run: airlock },
  { name: "canary blog render", run: canaryBlog },
  { name: "dashboard log-in render", run: loginPage },
];
