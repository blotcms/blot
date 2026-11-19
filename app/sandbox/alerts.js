// Emails the admin when the sandbox breaks, so its flags can go on quickly and
// a failure is noticed rather than found later:
//
//   - a job killed (over its memory), timed out, cut short or answered with
//     nonsense, the broker unreachable, or its queue full. A job that fails on
//     bad input ("failed") is the expected answer to a corrupt file, so it is
//     not reported, except from a job that answers bad input with meta.error
//     (FAILS_ONLY_WHEN_BROKEN), where it means the jail itself is broken. A
//     busy fetch-image or fetch is backpressure, logged and not reported.
//
// One email per process at most every ten minutes. What happens in between is
// counted and sent when the ten minutes are up, so a burst sends one email.
// A job failing the same way for the same blog again within a day is logged,
// not counted: a person re-saving a document too big for its jail would
// otherwise send an email every ten minutes they keep at it. The file's
// build flag tells them.

const config = require("config");
const clfdate = require("helper/clfdate");
const logContext = require("helper/logContext");

const INTERVAL_MS = 10 * 60 * 1000;
const REPEAT_MS = 24 * 60 * 60 * 1000;
const MAX_REPEATS = 1000;

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

// Jobs that turn whatever their input does into meta.error, so a failure is
// the jail's: its cgroup, network or filter
const FAILS_ONLY_WHEN_BROKEN = new Set(["fetch-image", "fetch"]);

// Jobs whose queue filling up is expected backpressure, not trouble: a build
// with many remote images queues past fetch-image's short queue by design, and
// so does a big import past fetch's. A busy answer is logged, with a count,
// instead of emailed.
// The screenshot batches queue behind each other in the one browser cgroup;
// helper/screenshot sends a busy batch again.
const BUSY_IS_BACKPRESSURE = new Set(["fetch-image", "fetch", "screenshot"]);

// Jobs whose timeout is the input's: a pandoc worker killed for taking too long
// on one document (build/converters/pandoc.js fails that document), as pandoc's
// own timeout was when each document had a jail, and a thumbnail of an image
// too slow to make (the build moves on to the post's next image). A job killed
// at its memory limit is SANDBOX_KILLED, which is still emailed.
const TIMEOUT_IS_THE_INPUT = new Set(["pandoc", "thumbnail"]);
const busyCounts = new Map();

const counts = new Map();
// When each blog last reported each failure, by "<blog> <what>"
const reported = new Map();
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

// Whether this blog has reported this failure in the last day. Outside a
// blog's work (no blog in the log context) every failure is new.
function repeated(what) {
  const blog = new Map(logContext.fields()).get("blog");
  if (!blog) return false;
  const key = blog + " " + what;
  const now = Date.now();
  const last = reported.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return true;
  reported.delete(key);
  reported.set(key, now);
  // The oldest go first, since a Map keeps the order keys were set in
  while (reported.size > MAX_REPEATS)
    reported.delete(reported.keys().next().value);
  return false;
}

function jobFailed(job, err) {
  if (!err) return;
  if (err.code === "SANDBOX_BUSY" && BUSY_IS_BACKPRESSURE.has(job)) {
    busyCounts.set(job, (busyCounts.get(job) || 0) + 1);
    console.log(
      clfdate(),
      `sandbox: job ${job} busy (${busyCounts.get(job)} since start)`
    );
    return;
  }
  if (err.code === "SANDBOX_TIMEOUT" && TIMEOUT_IS_THE_INPUT.has(job)) {
    console.log(clfdate(), `sandbox: job ${job} timed out`);
    return;
  }
  const broken =
    err.code === "SANDBOX_FAILED" && FAILS_ONLY_WHEN_BROKEN.has(job);
  if (!REPORTED.has(err.code) && !broken) return;
  const what = `job ${job}: ${err.code.slice("SANDBOX_".length).toLowerCase()}`;
  if (repeated(what)) {
    console.log(clfdate(), `sandbox: ${what} again for this blog, not emailed`);
    return;
  }
  report(what);
}

// For specs: forget what was counted and when the last email went, since other
// specs' sandbox failures land here too
function reset() {
  if (timer) clearTimeout(timer);
  timer = null;
  counts.clear();
  busyCounts.clear();
  reported.clear();
  lastSent = 0;
}

module.exports = { jobFailed, reset, REPORTED };
