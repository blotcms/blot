var client = require("models/client");
var folder = require("storage/folder");
var hash = require("helper/hash");
var clfdate = require("helper/clfdate");
var hold = require("sync/hold");

// Stops a file whose build blocks the event loop from crashing the process
// over and over (26 Nov 2026). A build that blocks the event loop past the
// folder lock's lease loses the lock, and sync/hold.js crashes the process
// so nothing writes without it. The follow-up queue then retries the sync on
// another process, which builds the same file and crashes in turn, forever.
//
// So each build first records an attempt in Redis, and removes it when it
// ends without having blocked the event loop for long. An attempt left
// behind is one which crashed, was killed, or blocked the event loop long
// enough to risk the lock. After MAX_ATTEMPTS of those within an hour, the
// file isn't built again: run() throws BUILD_STALLED, which the caller treats
// as any failed build (the existing post stays, the file is flagged
// BUILD_TIMEOUT, the sync carries on), and the maintainer gets an email.
//
// The attempt is written before the build, not when the lock is lost:
// after a long stall the Redis client is often offline (its replies timed
// out), so a write then would be lost.
//
// The key holds the file's SHA-1 (or its size and modified time), so an
// edit gets a fresh count; a folder post's folder has neither, so its edits
// share one. It expires an hour after the last attempt, so the next sync or
// rebuild after that tries the file again.

var MAX_ATTEMPTS = 2;
var ATTEMPT_TTL_SECONDS = 60 * 60;
var ALERT_TTL_SECONDS = 60 * 60;

var TICK_MS = 1000;

// A stall this long risks the lock: its lease is renewed every heartbeat
// and lasts LEASE_MS, so the lease can run out after LEASE_MS - HEARTBEAT_MS.
// A stall is measured as late as the timer is, up to TICK_MS less than it
// lasted, so less that too (specs lower it).
var options = { stallMs: hold.LEASE_MS - hold.HEARTBEAT_MS - TICK_MS };

// Event loop stalls, measured by a timer which should fire every TICK_MS.
// A stall is recorded by the first tick after it, numbered.
var lastTickAt = Date.now();
var ticks = 0;
var stalls = []; // { tick, endedAt, ms }, the last few minutes'
var ticker = null;

function tick() {
  var now = Date.now();
  var ms = now - lastTickAt - TICK_MS;
  lastTickAt = now;
  ticks += 1;
  if (ms >= options.stallMs) stalls.push({ tick: ticks, endedAt: now, ms: ms });
  while (stalls.length && stalls[0].endedAt < now - 10 * 60 * 1000)
    stalls.shift();
}

function startTicker() {
  if (ticker) return;
  lastTickAt = Date.now();
  ticker = setInterval(tick, TICK_MS);
  ticker.unref();
}

// How late the timer is: a stall still going on, or one which has just
// ended, whose end the timer hasn't seen yet (code that runs straight after
// a long synchronous step runs before the timer does)
function overdue() {
  return Math.max(0, Date.now() - lastTickAt - TICK_MS);
}

// Where a build starting now begins counting stalls: from the next tick, or
// from the one after it when a stall is already overdue, since that stall
// ended before this build began
function stallsFrom() {
  return ticks + (overdue() >= options.stallMs ? 1 : 0);
}

// The longest stall while a build which began counting at from was running
function stalledSince(from) {
  var longest = ticks >= from ? overdue() : 0;
  for (var stall of stalls)
    if (stall.tick > from) longest = Math.max(longest, stall.ms);
  return longest;
}

function attemptsKey(blogID, path, version) {
  return "blog:" + blogID + ":build-attempts:" + hash(path + "\0" + version);
}

function alertKey(blogID) {
  return "blog:" + blogID + ":build-stalled-alert";
}

// The file's SHA-1 from the folder's index, or its size and modified time,
// or "" if it can't be read (a folder post's folder has none of them)
async function versionOf(blogID, path) {
  try {
    var stat = await folder.stat(blogID, path, { sha1: true });
    if (!stat || stat.isDirectory) return "";
    return stat.sha1 || stat.size + ":" + stat.modified;
  } catch (err) {
    return "";
  }
}

function stalledError(blogID, path, attempts) {
  var err = new Error(
    "Not building " +
      path +
      ": its last " +
      attempts +
      " builds crashed or blocked the event loop"
  );
  err.code = "BUILD_STALLED";
  err.blogID = blogID;
  err.path = path;
  return err;
}

// Emails the maintainer, at most once an hour per blog. Never rejects.
async function alert(blog, path, attempts) {
  try {
    var first = await client.set(alertKey(blog.id), path, {
      NX: true,
      EX: ALERT_TTL_SECONDS,
    });
    if (!first) return;
    var email = require("helper/email");
    await email.BUILD_STALLED(null, {
      blogID: blog.id,
      handle: blog.handle,
      path: path,
      attempts: attempts,
    });
  } catch (err) {
    console.error(clfdate(), "[BUILD] stalled build alert failed", err);
  }
}

// Runs fn(), the build of path on blog, unless its last builds crashed or
// stalled (see above). Resolves or rejects as fn does, or rejects with
// BUILD_STALLED without running it. A Redis failure here never stops the
// build: it runs unguarded.
async function run(blog, path, fn) {
  startTicker();

  var key = attemptsKey(blog.id, path, await versionOf(blog.id, path));
  var recorded = false;

  try {
    var attempts = Number(await client.get(key)) || 0;
    if (attempts >= MAX_ATTEMPTS) {
      console.log(
        clfdate(),
        "[BUILD] skipped",
        blog.id,
        path,
        "after",
        attempts,
        "builds which crashed or blocked the event loop"
      );
      await alert(blog, path, attempts);
      throw stalledError(blog.id, path, attempts);
    }
    await client.multi().incr(key).expire(key, ATTEMPT_TTL_SECONDS).exec();
    recorded = true;
  } catch (err) {
    if (err.code === "BUILD_STALLED") throw err;
  }

  var from = stallsFrom();

  try {
    return await fn();
  } finally {
    var stalledMs = stalledSince(from);
    if (stalledMs >= options.stallMs) {
      // Left behind, as it is when the process crashes
      console.log(
        clfdate(),
        "[BUILD] blocked the event loop for",
        stalledMs + "ms",
        blog.id,
        path
      );
    } else if (recorded) {
      await client.del(key).catch(function () {});
    }
  }
}

module.exports = run;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.options = options;
module.exports.attemptsKey = attemptsKey;
module.exports.alertKey = alertKey;
module.exports.versionOf = versionOf;
