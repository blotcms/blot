// What a build found wrong with a file, to store as its flags
// (models/file/flags.js). Any step of a build, a converter, a plugin or the
// thumbnail, reports a flag with report(), without threading anything through:
// collect() runs a build with a list in its async context, the way
// helper/logContext carries a sync's ids. A report outside collect() (a build
// run by a script, a step finishing after its build timed out) goes nowhere.
//
//   const { result, flags } = await collect(() => build(blog, path));
//
// A step which publishes what it could not process as it was written (front
// matter, TeX, an embed's link) reports a flag and carries on: the flag is how
// the person finds it, not a reason to stop the build.

const { AsyncLocalStorage } = require("async_hooks");
const { CODES } = require("models/file/flags");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

const context = new AsyncLocalStorage();

function report(flag) {
  const found = context.getStore();

  if (found && flag && CODES[flag.code]) found.push(flag);
}

// One flag per code: the targets of several reports of a code are joined,
// once each, and the first report's other detail is kept
function merge(found) {
  const byCode = new Map();

  for (const flag of found) {
    const existing = byCode.get(flag.code);

    if (!existing) {
      byCode.set(
        flag.code,
        Object.assign({}, flag, flag.targets && { targets: [...flag.targets] })
      );
      continue;
    }

    if (flag.targets) {
      existing.targets = existing.targets || [];
      for (const target of flag.targets) {
        if (!existing.targets.some((t) => same(t, target)))
          existing.targets.push(target);
      }
    }
  }

  return [...byCode.values()];
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Resolves to { result, flags }, flags merged by code, or rejects with what fn
// threw, carrying the flags reported before it threw as err.flags
async function collect(fn) {
  const found = [];

  try {
    const result = await context.run(found, fn);
    return { result, flags: merge(found) };
  } catch (err) {
    if (err && typeof err === "object") err.flags = merge(found);
    throw err;
  }
}

// The flag for a build which failed, or null for a failure which says
// nothing about the file (Redis is down)
function fromError(err) {
  if (isRedisUnavailableError(err)) return null;

  const code = (err && err.code) || "";
  const cause = (err && err.cause && err.cause.code) || "";
  const message = (err && err.message) || String(err);
  const step = /^pandoc/i.test(message) ? "pandoc" : undefined;

  if (
    code === "SANDBOX_TIMEOUT" ||
    cause === "SANDBOX_TIMEOUT" ||
    /\(timed out\)/.test(message)
  ) {
    return { code: "BUILD_TIMEOUT", step };
  }

  if (code === "SANDBOX_KILLED") return { code: "BUILD_TOO_COMPLEX", step };

  if (
    [
      "SANDBOX_BUSY",
      "SANDBOX_UNAVAILABLE",
      "SANDBOX_BAD_REPLY",
      "SANDBOX_TRUNCATED",
    ].indexOf(code) !== -1
  ) {
    return { code: "BUILD_DEFERRED", step };
  }

  return { code: "BUILD_FAILED", step, error: message };
}

module.exports = { report, collect, fromError, merge };
