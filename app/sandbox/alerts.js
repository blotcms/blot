// Emails the admin when the sandbox breaks, so its flags can go on quickly and
// a failure is noticed rather than found later:
//
//   - a job killed (over its memory), timed out, cut short or answered with
//     nonsense, the broker unreachable, or its queue full. A job that fails on
//     bad input ("failed") is the expected answer to a corrupt file, so it is
//     not reported.
//   - from each web process (not the worker child), every five minutes, the
//     unit's fetch proxy, the sandbox's proxy jail. It must answer,
//     and must refuse the metadata address (tinyproxy says 500).
//
// One email per process at most every ten minutes. What happens in between is
// counted and sent when the ten minutes are up, so a burst sends one email.

const http = require("http");
const config = require("config");
const clfdate = require("helper/clfdate");

const INTERVAL_MS = 10 * 60 * 1000;
const PROXY_CHECK_MS = 5 * 60 * 1000;
const PROXY_TIMEOUT_MS = 15 * 1000;
const METADATA = "http://169.254.169.254/latest/meta-data/";

// The client's codes (./index.js) worth an email
const REPORTED = new Set([
  "SANDBOX_KILLED",
  "SANDBOX_TIMEOUT",
  "SANDBOX_UNAVAILABLE",
  "SANDBOX_BUSY",
  "SANDBOX_BAD_REPLY",
  "SANDBOX_TRUNCATED",
  "SANDBOX_OUTPUT_TOO_LARGE",
]);

const counts = new Map();
let lastSent = 0;
let timer = null;

function send() {
  timer = null;
  if (!counts.size) return;
  const lines = [...counts.entries()].map(([what, n]) => `${n} × ${what}`);
  counts.clear();
  lastSent = Date.now();
  console.error(clfdate(), "sandbox alert:", lines.join(", "));
  if (config.preview) return;
  // Required here: helper/email requires models, which require this module's
  // callers
  require("helper/email").SANDBOX_ALERT(null, {
    container: config.container,
    lines: lines.join("\n"),
  });
}

function report(what) {
  counts.set(what, (counts.get(what) || 0) + 1);
  if (timer) return;
  const wait = Math.max(0, lastSent + INTERVAL_MS - Date.now());
  timer = setTimeout(send, wait);
  timer.unref();
}

function jobFailed(job, err) {
  if (!err || !REPORTED.has(err.code)) return;
  report(`job ${job}: ${err.code.slice("SANDBOX_".length).toLowerCase()}`);
}

// Resolves with a problem, or null when the proxy refused the metadata address
function checkProxy(proxy) {
  return new Promise((resolve) => {
    const { hostname, port } = new URL(proxy);
    const req = http.get(
      { hostname, port, path: METADATA, headers: { host: "169.254.169.254" }, timeout: PROXY_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 500 ? null : `proxy let the metadata address through (${res.statusCode})`);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve(`proxy did not answer (${err.code || err.message})`));
  });
}

function watchProxy() {
  const proxy = config.egress && config.egress.proxy;
  if (!proxy) return;
  const check = async () => {
    const problem = await checkProxy(proxy);
    if (problem) report(problem);
  };
  setInterval(check, PROXY_CHECK_MS).unref();
}

// For specs: forget what was counted and when the last email went, since other
// specs' sandbox failures land here too
function reset() {
  if (timer) clearTimeout(timer);
  timer = null;
  counts.clear();
  lastSent = 0;
}

module.exports = { jobFailed, watchProxy, checkProxy, reset, REPORTED };
