var config = require("config");
var crypto = require("crypto");
var fs = require("fs-extra");
var { posix } = require("path");
var clfdate = require("helper/clfdate");
var local = require("./local");
var mirror = require("./mirror");
var { NotFoundError } = require("./errors");

// Shadow reads (#2258 Phase C): for blogs whose folder is mirrored to S3
// (./mirror.js), a sample of the reads made through storage/folder is
// repeated against the S3 backend, and the two answers are compared and
// timed. This is the measurement which says whether S3 can become
// authoritative (Phase D) and how big the content cache needs to be.
//
// The caller never sees any of it. index.js hands the caller exactly what the
// disk returned, when it returned it; the shadow starts on a later turn of
// the event loop, and everything it does is caught. Its cost is bounded: at
// most config.folder_shadow.max_in_flight shadows run at once per process (a
// sample over that is dropped and counted), files bigger than
// max_compare_bytes have their sizes compared instead of their bytes, and
// hashing is done a chunk at a time so a big file never blocks the loop.
//
// Reverse shadow reads (#2258 Phase D): for a blog on S3 (./primary.js) it
// runs the other way round. S3 answered the caller, and a sample of those
// reads (config.folder_shadow.reverse_rate, or rate when that is unset) is
// repeated against the blog's disk copy, which ./primary.js keeps in step
// behind S3. Everything below applies the same way, with the sides' roles
// swapped: the caller's own outcome is S3's, the disk is read afresh, and a
// mismatch means S3 served something the disk copy would not have. The disk
// copy is written just after S3 by every change, so a read which raced one
// differs for a moment; the recheck sees it agree and counts it as
// transient. A mismatch which outlasts the recheck on a blog whose disk copy
// is known to be behind (primary.DIRTY_KEY) counts as {op}:behind instead:
// the reconcile is already repairing that copy, and S3 did nothing wrong.
// Never for a blog whose backend a spec chose (index.js useBackend), which
// has no disk copy.
//
// What is compared, per call:
//
//   read                    the SHA-1 and length of the bytes each returned
//   ensureLocal             the SHA-1 and length of the file at each path
//   createReadStream, serve the SHA-1 of the same bytes (the same range)
//                           read again from each side once the caller is
//                           done: the caller's own stream is never touched
//   stat                    isDirectory; for a file, size, modified (within
//                           MODIFIED_TOLERANCE_MS) and sha1 when asked for
//   exists                  the boolean
//   list, listAll           names, isDirectory, and size and modified for
//                           files; list also whether there is a next page
//   listNames               names and isDirectory
//   resolveCaseInsensitive  the path each resolved to
//
// Names are compared after NFC normalisation, since S3 keys are NFC and a
// disk may hold either. A file missing on one side only is a mismatch. A
// mismatch is checked again after config.folder_shadow.recheck_ms, both sides
// afresh: a read which raced a sync (the disk changed, the mirror not yet)
// then matches and counts as transient rather than as drift.
//
// Counters are kept in memory and added every FLUSH_MS to one Redis hash per
// hour, KEY_PREFIX + "YYYYMMDDHH" (UTC), which expires after TTL_SECONDS:
//
//   {op}:sampled            shadows which ran to a verdict
//   {op}:matched            ... and agreed
//   {op}:mismatched         ... and disagreed, still, after the recheck
//   {op}:mismatch:{kind}    ... by kind (see compare() for the kinds)
//   {op}:transient          ... and disagreed, then agreed on the recheck
//   {op}:transient:{kind}
//   {op}:s3error            S3 failed with something other than "not found"
//   {op}:s3error:{code}
//   {op}:dropped            samples not run, over max_in_flight
//   {op}:large              sampled files over max_compare_bytes
//   {op}:skipped            the disk itself failed (ELOOP, say): no verdict
//   {op}:local:le:{ms}      latency histograms: how many calls took at most
//   {op}:s3:le:{ms}         ms, for each bound in BUCKETS ("inf" last)
//   {op}:s3:{outcome}:le:{ms}
//                           for read, createReadStream, serve and
//                           ensureLocal, the S3 side's latencies again, by
//                           how the content cache served it: hit (had the
//                           file), miss (fetched it from S3) or direct (not
//                           through the cache: over max_file_bytes, or it
//                           fell back on ECHANGED or a disk error). A hit
//                           costs about a millisecond, a miss an S3 GET, so
//                           the blend in {op}:s3:le says little. Hours
//                           recorded before this have only the blend.
//   {op}:local:ttfb:le:{ms}
//   {op}:s3:ttfb:le:{ms}    for createReadStream and serve, how long each
//                           side took to give its first chunk (what a
//                           visitor waits for), where {op}:{side}:le:{ms} is
//                           the whole transfer and hash
//   cache:{counter}         the content cache's hits, misses, evictions,
//                           fetchedBytes, changed and filled (entries its
//                           write-through added) since the last flush
//   reverse:{field}         each {op} field above, for the reverse
//                           direction: "reverse:read:sampled", and so on.
//                           Forward fields have no prefix, as before there
//                           were two directions. For read and ensureLocal the
//                           S3 latency is the caller's own, with its cache
//                           outcome; for the streamed calls both sides are
//                           read again, as forward.
//   reverse:{op}:behind     reverse only: mismatches on a disk copy already
//   reverse:{op}:behind:{kind}  known to be behind S3 (not counted as
//                           mismatched)
//
// No path goes to Redis: scripts/storage/shadow-report.js turns these into
// a summary. A mismatch or S3 error is logged on the host with its path, once
// per direction, blog, call, kind and path, and at most LOG_LIMIT lines a
// minute; a reverse line says direction=reverse.

var LOG_PREFIX = "[storage/folder shadow]";
var KEY_PREFIX = "storage:folder:shadow:";
var TTL_SECONDS = 14 * 24 * 60 * 60;
var FLUSH_MS = 60 * 1000;

// Disk times are fractional; the index keeps whole milliseconds
var MODIFIED_TOLERANCE_MS = 1000;

// Upper bounds of the latency histograms, in ms
var BUCKETS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 10000, 30000];

// Bytes hashed before giving the event loop a turn
var HASH_CHUNK = 256 * 1024;

var LOG_LIMIT = 30;
var LOGGED_MAX = 10000;

var CACHE_OUTCOMES = ["hit", "miss", "direct"];

// Which side answered the caller: the disk, for a blog on disk, or S3, for a
// blog on S3. A reverse counter is the forward one with REVERSE + ":" in
// front ("reverse:read:sampled"); forward counters have nothing in front, as
// before there were two directions.
var FORWARD = "forward";
var REVERSE = "reverse";

var CACHE_COUNTERS = ["hits", "misses", "evictions", "fetchedBytes", "changed", "filled"];

var OPS = [
  "read",
  "stat",
  "exists",
  "list",
  "listNames",
  "listAll",
  "resolveCaseInsensitive",
  "ensureLocal",
  "createReadStream",
  "serve",
];

var pending = {};
var inFlight = new Set();
var timer = null;
var usedCache = false;
var lastCache = null;
var logged = new Set();
var logWindow = { started: 0, lines: 0 };

function noop() {}

// Loaded on first use, so requiring storage/folder connects to nothing
function redis() {
  return require("models/client");
}

function s3() {
  return require("./s3");
}

function settings() {
  return config.folder_shadow || {};
}

// Whether to shadow this call: the blog is mirrored and the dice say so
function pick(blogID) {
  var rate = Number(settings().rate) || 0;

  if (!(rate > 0) || typeof blogID !== "string") return false;
  if (rate < 1 && Math.random() >= rate) return false;

  return mirror.enabledFor(blogID);
}

// The fraction of reads of blogs on S3 to shadow: reverse_rate, or rate
// when that is unset
function reverseRate() {
  var value = settings().reverse_rate;

  if (value === undefined || value === null || value === "") return Number(settings().rate) || 0;

  return Number(value) || 0;
}

// Whether to shadow this read of a blog on S3 (index.js asks only for those)
function pickReverse(blogID) {
  var rate = reverseRate();

  if (!(rate > 0) || typeof blogID !== "string") return false;

  return rate >= 1 || Math.random() < rate;
}

function bump(field, by) {
  pending[field] = (pending[field] || 0) + (by === undefined ? 1 : by);

  if (!timer) {
    timer = setInterval(function () {
      flush().catch(noop);
    }, FLUSH_MS);
    timer.unref();
  }
}

function bucketOf(ms) {
  for (var i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]) return String(BUCKETS[i]);
  return "inf";
}

function observe(op, side, ms) {
  if (typeof ms === "number") bump(op + ":" + side + ":le:" + bucketOf(ms));
}

function since(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// A directory read as a file is "not there", as serve and S3 treat it
function isMissing(err) {
  return !!(err && (err instanceof NotFoundError || ["ENOENT", "ENOTDIR", "EISDIR"].indexOf(err.code) !== -1));
}

function outcomeOf(err) {
  return isMissing(err) ? { missing: true } : { error: err };
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return outcomeOf(err);
  }
}

// fn is given a clock, whose firstByte() records the time to a stream's
// first chunk (the first call counts); outcome.ttfb is that, if it was
async function timed(fn) {
  var started = process.hrtime.bigint();
  var clock = {
    ttfb: undefined,
    firstByte: function () {
      if (clock.ttfb === undefined) clock.ttfb = since(started);
    },
  };
  var outcome = await attempt(function () {
    return fn(clock);
  });

  outcome.ms = since(started);
  if (clock.ttfb !== undefined) outcome.ttfb = clock.ttfb;

  return outcome;
}

function yieldToLoop() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

// SHA-1 of a buffer, a chunk per turn of the event loop
async function hashBuffer(buffer) {
  var hash = crypto.createHash("sha1");

  for (var i = 0; i < buffer.length; i += HASH_CHUNK) {
    hash.update(buffer.subarray(i, i + HASH_CHUNK));
    if (i + HASH_CHUNK < buffer.length) await yieldToLoop();
  }

  return hash.digest("hex");
}

async function hashStream(stream, clock) {
  var hash = crypto.createHash("sha1");
  var size = 0;

  for await (var chunk of stream) {
    if (clock) clock.firstByte();
    hash.update(chunk);
    size += chunk.length;
  }

  return { size: size, sha1: hash.digest("hex") };
}

function maxCompareBytes() {
  var max = Number(settings().max_compare_bytes);
  return max >= 0 ? max : Infinity;
}

async function digestBuffer(buffer) {
  if (buffer.length > maxCompareBytes()) return { size: buffer.length, large: true };

  return { size: buffer.length, sha1: await hashBuffer(buffer) };
}

async function digestFile(path) {
  var stat = await fs.stat(path);

  if (stat.isDirectory()) throw new NotFoundError();
  if (stat.size > maxCompareBytes()) return { size: stat.size, large: true };

  return hashStream(fs.createReadStream(path));
}

// Turns an outcome's value into what is compared, leaving failures alone
async function digest(outcome, fn) {
  if (!outcome.ok) return outcome;

  try {
    return { ok: true, value: await fn(outcome.value), ms: outcome.ms, ttfb: outcome.ttfb };
  } catch (err) {
    return Object.assign(outcomeOf(err), { ms: outcome.ms, ttfb: outcome.ttfb });
  }
}

// The size S3's index gives a file, for one too big to compare by bytes
async function s3Size(blogID, path) {
  return attempt(async function () {
    var stat = await s3().stat(blogID, path);
    if (stat.isDirectory) throw new NotFoundError();
    return { size: stat.size, large: true };
  });
}

// The size the disk gives a file, for one S3 found too big to compare by
// bytes (a blog on S3, whose S3 side came first)
async function localSize(blogID, path) {
  return attempt(async function () {
    var stat = await local.stat(blogID, path);
    if (stat.isDirectory) throw new NotFoundError();
    return { size: stat.size, large: true };
  });
}

// Whether the disk has a file, without reading it, for comparing with a read
// which failed on S3
async function diskPresence(blogID, path) {
  return attempt(async function () {
    var stat = await local.stat(blogID, path);
    if (stat.isDirectory) throw new NotFoundError();
    return { size: stat.size };
  });
}

// For a blog on S3, given the caller's own outcome from S3 (first): that is
// looked at before anything else, so a read the caller saw fail (a timeout, a
// missing object) is never settled by the index's size. A failed read is
// compared with whether the disk copy has the file, a file too big to compare
// by bytes by its size, and anything else by the disk copy's bytes.
async function againstDiskCopy(blogID, path, first, digestFn, readLocal) {
  var s3Side = await digest(first, digestFn);

  s3Side.cache = first.cache;

  if (!s3Side.ok) return { local: await diskPresence(blogID, path), s3: s3Side };
  if (s3Side.value.large) return { local: await localSize(blogID, path), s3: s3Side };

  return { local: await digest(await timed(readLocal), digestFn), s3: s3Side };
}

// A file's bytes (or a range of them) read again from both sides, for the
// calls whose result the caller consumes as it goes: a stream and serve
async function rereadFile(blogID, path, range) {
  var stat;

  try {
    stat = await local.stat(blogID, path);
    if (stat.isDirectory) throw new NotFoundError();
  } catch (err) {
    // Missing on disk: whether S3 has the file is all that matters, so ask
    // its index rather than download what may be a big file
    return {
      local: outcomeOf(err),
      s3: await attempt(async function () {
        var found = await s3().stat(blogID, path);
        if (found.isDirectory) throw new NotFoundError();
        return { size: found.size };
      }),
    };
  }

  var start = range && range.start !== undefined ? range.start : 0;
  var end = range && range.end !== undefined ? Math.min(range.end, stat.size - 1) : stat.size - 1;

  if (end - start + 1 > maxCompareBytes()) {
    return { local: { ok: true, value: { size: stat.size, large: true } }, s3: await s3Size(blogID, path) };
  }

  var trace = {};
  var localSide = await timed(function (clock) {
    return hashStream(local.createReadStream(blogID, path, range), clock);
  });
  var s3Side = await timed(function (clock) {
    return hashStream(s3().createReadStream(blogID, path, range, trace), clock);
  });

  s3Side.cache = trace.cache;

  return { local: localSide, s3: s3Side };
}

function range(options) {
  if (!options || (options.start === undefined && options.end === undefined)) return undefined;
  return { start: options.start, end: options.end };
}

// The file serve sends for a path: a trailing slash is its index.html
function servedPath(relPath) {
  return !relPath || relPath.slice(-1) === "/" ? posix.join(relPath || "/", "index.html") : relPath;
}

// Each runs both sides of one call, given the caller's own outcome from the
// disk (first) or null to read the disk afresh, and resolves to
// { local, s3 }: outcomes whose values are what DIFF compares, each with the
// ms it took where that is worth recording.
var RUN = {
  read: async function (args, first, reverse) {
    var blogID = args[0];
    var path = args[1];
    var trace = {};

    usedCache = true;

    if (reverse && first) {
      return againstDiskCopy(blogID, path, first, digestBuffer, function () {
        return local.read(blogID, path);
      });
    }

    var localSide = await digest(
      first ||
        (await timed(function () {
          return local.read(blogID, path);
        })),
      digestBuffer
    );

    if (localSide.ok && localSide.value.large) return { local: localSide, s3: await s3Size(blogID, path) };

    var s3Side = await digest(
      await timed(function () {
        return s3().read(blogID, path, trace);
      }),
      digestBuffer
    );

    s3Side.cache = trace.cache;

    if (s3Side.ok && s3Side.value.large) return { local: await localSize(blogID, path), s3: s3Side };

    return { local: localSide, s3: s3Side };
  },

  ensureLocal: async function (args, first, reverse) {
    var blogID = args[0];
    var path = args[1];
    var trace = {};

    if (reverse && first) {
      usedCache = true;
      return againstDiskCopy(blogID, path, first, digestFile, function () {
        return local.ensureLocal(blogID, path);
      });
    }

    var localSide = await digest(
      first ||
        (await timed(function () {
          return local.ensureLocal(blogID, path);
        })),
      digestFile
    );

    if (localSide.ok && localSide.value.large) return { local: localSide, s3: await s3Size(blogID, path) };

    usedCache = true;

    var s3Side = await digest(
      await timed(function () {
        return s3().ensureLocal(blogID, path, trace);
      }),
      digestFile
    );

    s3Side.cache = trace.cache;

    if (s3Side.ok && s3Side.value.large) return { local: await localSize(blogID, path), s3: s3Side };

    return { local: localSide, s3: s3Side };
  },

  createReadStream: function (args) {
    usedCache = true;
    return rereadFile(args[0], args[1], range(args[2]));
  },

  serve: function (args) {
    var blogID = args[2];
    var relPath = args[3];
    var options = args[4] || {};
    var path = servedPath(relPath);

    // Both backends refuse these without looking
    if (
      options.dotfiles === "ignore" &&
      path.split("/").some(function (segment) {
        return segment.charAt(0) === ".";
      })
    ) {
      return null;
    }

    usedCache = true;
    return rereadFile(blogID, path);
  },

  stat: async function (args, first, reverse) {
    var blogID = args[0];
    var path = args[1];
    // The Dropbox hash costs S3 a download, and isn't stored, so only the
    // SHA-1 is asked of both
    var options = { sha1: !!(args[2] && args[2].sha1) };

    return {
      local:
        (!reverse && first) ||
        (await timed(function () {
          return local.stat(blogID, path, options);
        })),
      s3:
        (reverse && first) ||
        (await timed(function () {
          return s3().stat(blogID, path, options);
        })),
    };
  },
};

// The rest call the same function, with the same arguments, on each side
["exists", "list", "listNames", "listAll", "resolveCaseInsensitive"].forEach(function (op) {
  RUN[op] = async function (args, first, reverse) {
    return {
      local:
        (!reverse && first) ||
        (await timed(function () {
          return local[op].apply(null, args);
        })),
      s3:
        (reverse && first) ||
        (await timed(function () {
          return s3()[op].apply(null, args);
        })),
    };
  };
});

function nfc(name) {
  return String(name).normalize("NFC");
}

function differentTime(a, b) {
  return Math.abs(Number(a) - Number(b)) > MODIFIED_TOLERANCE_MS;
}

function diffBytes(a, b) {
  if (a.size !== b.size) return "size";
  if (a.large || b.large) return null;
  return a.sha1 === b.sha1 ? null : "bytes";
}

// Directory entries: the same names, then the same kind and, with meta, the
// same size and modified time for each file
function diffEntries(a, b, meta) {
  function byName(x, y) {
    return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
  }

  function normal(entries) {
    return (entries || [])
      .map(function (entry) {
        return Object.assign({}, entry, { name: nfc(entry.name) });
      })
      .sort(byName);
  }

  a = normal(a);
  b = normal(b);

  if (a.length !== b.length) return "names";

  for (var i = 0; i < a.length; i++) if (a[i].name !== b[i].name) return "names";

  for (i = 0; i < a.length; i++) {
    if (!!a[i].isDirectory !== !!b[i].isDirectory) return "type";
    if (!meta || a[i].isDirectory) continue;
    if (a[i].size !== b[i].size) return "size";
    if (differentTime(a[i].modified, b[i].modified)) return "modified";
  }

  return null;
}

// A kind of mismatch, or null when both sides agree
var DIFF = {
  read: diffBytes,
  ensureLocal: diffBytes,
  createReadStream: diffBytes,
  serve: diffBytes,
  stat: function (a, b) {
    if (!!a.isDirectory !== !!b.isDirectory) return "type";
    if (a.isDirectory) return null;
    if (a.size !== b.size) return "size";
    if (differentTime(a.modified, b.modified)) return "modified";
    if (a.sha1 && b.sha1 && a.sha1 !== b.sha1) return "bytes";
    return null;
  },
  exists: function (a, b) {
    if (a === b) return null;
    return a ? "missing-in-s3" : "extra-in-s3";
  },
  list: function (a, b) {
    return diffEntries(a.entries, b.entries, true) || (!!a.cursor !== !!b.cursor ? "names" : null);
  },
  listAll: function (a, b) {
    return diffEntries(a, b, true);
  },
  listNames: function (a, b) {
    return diffEntries(a, b, false);
  },
  resolveCaseInsensitive: function (a, b) {
    return nfc(a) === nfc(b) ? null : "path";
  },
};

// { skip } when the disk failed, { s3Error } when S3 did, otherwise
// { kind }: null for agreement, or what differs. Kinds: "missing-in-s3" (the
// disk has it, S3 doesn't), "extra-in-s3" (the reverse), "type" (file or
// directory), "size", "modified", "bytes", "names" (a listing's names or
// paging), "path" (resolveCaseInsensitive)
function compare(op, pass) {
  if (pass.local.error) return { skip: true };
  if (pass.s3.error) return { s3Error: pass.s3.error };
  if (pass.local.missing && pass.s3.missing) return { kind: null };
  if (pass.local.missing) return { kind: "extra-in-s3" };
  if (pass.s3.missing) return { kind: "missing-in-s3" };

  return { kind: DIFF[op](pass.local.value, pass.s3.value) };
}

function blogOf(op, args) {
  return op === "serve" ? args[2] : args[0];
}

function pathOf(op, args) {
  return op === "serve" ? servedPath(args[3]) : args[1] || "/";
}

// A line for the host's log, once per blog, call, kind and path, and no more
// than LOG_LIMIT a minute
function log(key, message) {
  var now = Date.now();

  if (logged.has(key)) return;

  if (now - logWindow.started > 60 * 1000) logWindow = { started: now, lines: 0 };
  if (logWindow.lines >= LOG_LIMIT) return;

  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(key);
  logWindow.lines++;

  console.error(clfdate(), LOG_PREFIX, message);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Whether a blog's disk copy is known to be behind S3 (a copy to disk
// failed, and the reconcile has not yet repaired it), for a blog on S3
async function copyBehind(blogID) {
  var reply = await redis().sIsMember(require("./primary").DIRTY_KEY, blogID);
  return !!reply && reply !== "0";
}

// direction is FORWARD (the disk answered the caller, for a blog on disk) or
// REVERSE (S3 answered, for a blog on S3, checked against its disk copy)
async function run(op, args, first, direction) {
  var reverse = direction === REVERSE;
  var prefix = reverse ? REVERSE + ":" : "";
  var blogID = blogOf(op, args);
  var path = pathOf(op, args);
  var pass = await RUN[op](args, first, reverse);

  function count(field) {
    bump(prefix + op + ":" + field);
  }

  function line(text) {
    return text + " blog=" + blogID + (reverse ? " direction=" + REVERSE : "") + " op=" + op;
  }

  if (!pass) return;

  var verdict = compare(op, pass);

  if (verdict.skip) return count("skipped");

  count("sampled");

  if ((pass.local.ok && pass.local.value && pass.local.value.large) || (pass.s3.ok && pass.s3.value && pass.s3.value.large)) {
    count("large");
  } else {
    observe(prefix + op, "local", pass.local.ms);
    observe(prefix + op, "local:ttfb", pass.local.ttfb);

    if (!verdict.s3Error) {
      observe(prefix + op, "s3", pass.s3.ms);
      observe(prefix + op, "s3:ttfb", pass.s3.ttfb);
      // By how the content cache served the read, where it was asked
      if (CACHE_OUTCOMES.indexOf(pass.s3.cache) !== -1) observe(prefix + op, "s3:" + pass.s3.cache, pass.s3.ms);
    }
  }

  function s3Error(err) {
    var code = String(err.code || err.name || "error").replace(/[^\w-]/g, "");

    count("s3error");
    count("s3error:" + code);
    log(
      [direction, blogID, op, "error", code, path].join("\0"),
      line("s3 error") + " path=" + JSON.stringify(path) + " error=" + code + " " + err.message
    );
  }

  if (verdict.s3Error) return s3Error(verdict.s3Error);

  if (!verdict.kind) return count("matched");

  var kind = verdict.kind;
  var wait = Number(settings().recheck_ms) || 0;

  if (wait > 0) await delay(wait);

  var again = compare(op, (await RUN[op](args, null, reverse)) || pass);

  // A recheck which could not read one side confirms nothing, so the
  // discrepancy is not counted as drift
  if (again.skip) return count("skipped");
  if (again.s3Error) return s3Error(again.s3Error);

  if (!again.kind) {
    count("transient");
    count("transient:" + kind);
    return;
  }

  kind = again.kind;

  // A disk copy known to be behind S3 is already in the reconcile's hands:
  // it differs because a copy to disk failed, not because S3 served
  // something wrong
  if (reverse && (await copyBehind(blogID))) {
    count("behind");
    count("behind:" + kind);
    return;
  }

  count("mismatched");
  count("mismatch:" + kind);
  log([direction, blogID, op, kind, path].join("\0"), line("mismatch") + " kind=" + kind + " path=" + JSON.stringify(path));
}

// Takes a slot and runs the shadow on a later turn of the event loop, so the
// caller's own code runs first. Never throws or rejects.
function start(op, args, first, direction) {
  try {
    var max = Number(settings().max_in_flight);

    if (inFlight.size >= (max >= 0 ? max : 4)) return bump((direction === REVERSE ? REVERSE + ":" : "") + op + ":dropped");

    var shadow = yieldToLoop()
      .then(function () {
        return run(op, args, first, direction);
      })
      .catch(function (err) {
        log("failed\0" + op + "\0" + (err && err.message), "failed op=" + op + " " + ((err && err.stack) || err));
      })
      .finally(function () {
        inFlight.delete(shadow);
      });

    inFlight.add(shadow);
  } catch (err) {
    // Nothing here may reach the caller
  }
}

// Runs one call of a backend's read for the caller, and starts a shadow of
// it once it has settled. Returns exactly what call returned.
function sample(op, call, args, direction) {
  // The caller's stream is left alone; the file is read again once it is done
  if (op === "createReadStream") {
    var stream = call.apply(null, args);

    stream.once("close", function () {
      start(op, args, null, direction);
    });

    return stream;
  }

  var started = process.hrtime.bigint();
  var trace = null;
  var callArgs = args;

  // For a blog on S3, the caller's own read says how the content cache
  // served it, as the S3 side of a forward shadow does. Only with the
  // arguments the facade documents, so the trace never takes the place of
  // something a caller passed.
  if (direction === REVERSE && (op === "read" || op === "ensureLocal") && args.length <= 2) {
    trace = {};
    callArgs = [args[0], args[1], trace];
  }

  var promise = call.apply(null, callArgs);

  if (!promise || typeof promise.then !== "function") return promise;

  function outcome(fields) {
    fields.ms = since(started);
    if (trace) fields.cache = trace.cache;
    return fields;
  }

  // serve's outcome is ignored: the shadow reads the file it sent again
  promise.then(
    function (value) {
      start(op, args, op === "serve" ? null : outcome({ ok: true, value: value }), direction);
    },
    function (err) {
      start(op, args, op === "serve" ? null : outcome(outcomeOf(err)), direction);
    }
  );

  return promise;
}

// Called by index.js in place of call(...args) for each read it sends to
// the local backend. Returns exactly what call returned.
function shadow(op, call, args) {
  if (!pick(blogOf(op, args))) return call.apply(null, args);

  return sample(op, call, args, FORWARD);
}

// Called by index.js in place of call(...args) for each read it sends to
// the S3 backend for a blog on S3 (./primary.js), whose disk copy it checks
// against. Never when a spec chose the backend: that blog has no disk copy.
// Returns exactly what call returned.
function reverse(op, call, args) {
  if (!pickReverse(blogOf(op, args))) return call.apply(null, args);

  return sample(op, call, args, REVERSE);
}

function hourKey(date) {
  return KEY_PREFIX + date.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

// What the content cache counted since the last flush, once a shadow has
// used it (stats() would otherwise create a cache this process doesn't need)
function cacheDelta() {
  if (!usedCache) return;

  var stats = require("./cache")().stats();
  var previous = lastCache || {};

  lastCache = stats;

  CACHE_COUNTERS.forEach(function (name) {
    var delta = (stats[name] || 0) - (previous[name] || 0);
    if (delta > 0) bump("cache:" + name, delta);
  });
}

// Adds the counters to this hour's hash. Counts which fail to reach Redis are
// kept for the next flush.
async function flush() {
  try {
    cacheDelta();
  } catch (err) {
    log("cache\0" + err.message, "could not read the cache's stats: " + err.message);
  }

  var fields = pending;
  var names = Object.keys(fields);

  pending = {};

  if (!names.length) return;

  var key = hourKey(new Date());
  var batch = redis().multi();

  names.forEach(function (name) {
    batch.hIncrBy(key, name, fields[name]);
  });

  batch.expire(key, TTL_SECONDS);

  try {
    await batch.exec();
  } catch (err) {
    names.forEach(function (name) {
      pending[name] = (pending[name] || 0) + fields[name];
    });
    log("flush\0" + err.message, "could not record counters: " + err.message);
  }
}

// Resolves once every shadow running now has finished. For specs.
async function idle() {
  while (inFlight.size) await Promise.all(Array.from(inFlight));
}

// The counters not yet flushed. For specs.
function counters() {
  return Object.assign({}, pending);
}

// Forgets the counters and what has been logged, and stops the periodic
// flush until something is counted again. For specs.
function reset() {
  if (timer) clearInterval(timer);
  timer = null;
  pending = {};
  logged.clear();
  logWindow = { started: 0, lines: 0 };
}

module.exports = shadow;
module.exports.reverse = reverse;
module.exports.REVERSE = REVERSE;
module.exports.OPS = OPS;
module.exports.BUCKETS = BUCKETS;
module.exports.CACHE_OUTCOMES = CACHE_OUTCOMES;
module.exports.KEY_PREFIX = KEY_PREFIX;
module.exports.TTL_SECONDS = TTL_SECONDS;
module.exports.LOG_PREFIX = LOG_PREFIX;
module.exports.hourKey = hourKey;
module.exports.flush = flush;
module.exports.idle = idle;
module.exports.counters = counters;
module.exports.reset = reset;
