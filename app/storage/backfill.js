const fs = require("fs-extra");
const { join } = require("path");
const config = require("config");
const s3 = require("./s3");
const { walkLocal, createPool } = require("./util");

// Copies a local copy of the assets into the bucket (scripts/storage/
// backfill-assets.js is the command line for this), for re-seeding it from a
// backup or an old data/static directory. For each blog it lists
// the keys already in S3, walks the blog's directory and uploads the files
// which are missing there or whose size differs, with the same headers
// assets.commit gives (s3.upload). In verify mode nothing is uploaded; the
// result says what would be missing or different. Safe to run again and again.

// Keys which may not survive a trip from a CDN URL to the bucket unchanged:
// characters which are special in URLs, control characters, spaces at the
// ends of a path segment, and anything non-ASCII.
const ODD_KEY = /[+%#?\\\u0000-\u001f\u007f]|[^\u0000-\u007f]|(^|\/)\s|\s(\/|$)/;

const MAX_LISTED = {
  keys: 50,
  ignored: 10,
  errors: 100,
};

function isOddKey(key) {
  return ODD_KEY.test(key);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;

  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }

  return (i ? bytes.toFixed(1) : Math.round(bytes)) + " " + units[i];
}

// options:
//   blog         only this blog
//   from         start at this blog (inclusive)
//   concurrency  uploads at once, across blogs (default 16)
//   dryRun       report what would be uploaded
//   verify       report what's missing or different, uploading nothing
//   log          function for output (default console.log)
//   directory    the directory of blog directories (required)
//   progressEvery / progressIntervalMs
//                a progress line this many files / ms apart, whichever first
async function backfill(options) {
  options = options || {};

  const log = options.log || console.log;
  const directory = options.directory;

  if (!directory) {
    throw new Error("storage/backfill: options.directory is required");
  }

  const concurrency = options.concurrency || 16;
  const progressEvery = options.progressEvery || 5000;
  const progressIntervalMs = options.progressIntervalMs || 10000;
  const verify = !!options.verify;
  const dryRun = !!options.dryRun;
  const readonly = verify || dryRun;

  const stats = {
    blogs: 0,
    scanned: 0,
    uploaded: 0,
    bytes: 0, // uploaded, or to upload in a dry run
    missing: 0,
    mismatched: 0,
    errors: 0,
    ignored: 0,
    bySubdirectory: {},
    oddKeys: { count: 0, keys: [] },
    errorMessages: [],
    seconds: 0,
  };

  const started = Date.now();
  let lastProgress = started;
  let scannedAtLastProgress = 0;

  function progress(force) {
    const now = Date.now();

    if (
      !force &&
      stats.scanned - scannedAtLastProgress < progressEvery &&
      now - lastProgress < progressIntervalMs
    ) {
      return;
    }

    const seconds = Math.max((now - started) / 1000, 0.001);

    log(
      "[backfill] blogs=" + stats.blogs,
      "scanned=" + stats.scanned,
      (readonly ? "to-upload=" + (stats.missing + stats.mismatched) : "uploaded=" + stats.uploaded),
      "bytes=" + formatBytes(stats.bytes),
      "errors=" + stats.errors,
      "rate=" + (stats.scanned / seconds).toFixed(0) + " files/s",
      formatBytes(stats.bytes / seconds) + "/s"
    );

    lastProgress = now;
    scannedAtLastProgress = stats.scanned;
  }

  function fail(message, err) {
    stats.errors++;

    if (stats.errorMessages.length < MAX_LISTED.errors) {
      const line = message + ": " + (err && err.message ? err.message : err);
      stats.errorMessages.push(line);
      log("[backfill] error " + line);
    }
  }

  function subdirectory(rel) {
    const name = rel.indexOf("/") === -1 ? "(top level)" : rel.split("/")[0];

    if (!stats.bySubdirectory[name]) {
      stats.bySubdirectory[name] = { scanned: 0, missing: 0, mismatched: 0 };
    }

    return stats.bySubdirectory[name];
  }

  // Only blog_* directories are backfilled; count the rest
  const names = [];
  const ignored = [];

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^blog_/.test(entry.name)) names.push(entry.name);
    else ignored.push(entry.name);
  }

  names.sort();
  stats.ignored = ignored.length;

  log(
    "[backfill] ignoring " + ignored.length + " entries which aren't blog_* directories" +
      (ignored.length
        ? ", e.g. " + ignored.slice(0, MAX_LISTED.ignored).join(", ")
        : "")
  );

  let blogs = names;

  if (options.blog) blogs = blogs.filter((name) => name === options.blog);
  if (options.from) blogs = blogs.filter((name) => name >= options.from);

  if (options.blog && !blogs.length) {
    fail("blog " + options.blog, "no such directory in " + directory);
  }

  log(
    "[backfill] " +
      (verify ? "verifying" : dryRun ? "dry run over" : "uploading") +
      " " + blogs.length + " blogs"
  );

  const pool = createPool(concurrency);

  async function processBlog(blogID) {
    const blogDirectory = join(directory, blogID);
    const remote = new Map();

    try {
      for await (const object of s3.listEntries(blogID + "/")) {
        remote.set(object.key, object.size);
      }
    } catch (err) {
      return fail("listing " + blogID, err);
    }

    for await (const rel of walkLocal(blogDirectory)) {
      const key = blogID + "/" + rel;
      const local = join(blogDirectory, rel);
      let size;

      try {
        size = (await fs.stat(local)).size;
      } catch (err) {
        // removed since we listed the directory
        if (err.code === "ENOENT") continue;
        fail("stat " + key, err);
        continue;
      }

      stats.scanned++;
      subdirectory(rel).scanned++;

      if (isOddKey(key)) {
        stats.oddKeys.count++;
        if (stats.oddKeys.keys.length < MAX_LISTED.keys) {
          stats.oddKeys.keys.push(key);
        }
      }

      const remoteSize = remote.get(key);

      if (remoteSize === size) {
        progress();
        continue;
      }

      if (remoteSize === undefined) {
        stats.missing++;
        subdirectory(rel).missing++;
      } else {
        stats.mismatched++;
        subdirectory(rel).mismatched++;
      }

      if (readonly) {
        stats.bytes += size;
        progress();
        continue;
      }

      await pool.add(async function () {
        try {
          await s3.upload(blogID, rel, local);
          stats.uploaded++;
          stats.bytes += size;
        } catch (err) {
          fail("uploading " + key, err);
        }
      });

      progress();
    }

    stats.blogs++;
  }

  for (const blogID of blogs) {
    try {
      await processBlog(blogID);
    } catch (err) {
      fail("blog " + blogID, err);
    }
  }

  await pool.drain();

  stats.seconds = (Date.now() - started) / 1000;
  progress(true);

  return stats;
}

// A readable summary of what backfill() returned
function summarise(stats, options) {
  options = options || {};

  const lines = [];
  const readonly = options.verify || options.dryRun;
  const names = Object.keys(stats.bySubdirectory).sort();

  lines.push("");
  lines.push(
    "Scanned " + stats.scanned + " files in " + stats.blogs + " blogs in " +
      stats.seconds.toFixed(1) + "s (" + stats.ignored + " entries ignored)"
  );

  if (options.verify) {
    lines.push("Missing from the bucket: " + stats.missing);
    lines.push("Different size in the bucket: " + stats.mismatched);
  } else if (options.dryRun) {
    lines.push(
      "Would upload " + (stats.missing + stats.mismatched) + " files (" +
        stats.missing + " missing, " + stats.mismatched + " different size), " +
        formatBytes(stats.bytes)
    );
  } else {
    lines.push("Uploaded " + stats.uploaded + " files, " + formatBytes(stats.bytes));
  }

  if (names.length) {
    lines.push("");
    lines.push("By directory (scanned / " + (readonly ? "" : "had been ") + "missing / different size):");

    for (const name of names) {
      const entry = stats.bySubdirectory[name];
      lines.push(
        "  " + name + ": " + entry.scanned + " / " + entry.missing + " / " + entry.mismatched
      );
    }
  }

  if (readonly || stats.oddKeys.count) {
    const count = stats.oddKeys.count;

    lines.push("");
    lines.push(
      count +
        " keys may not survive a plain CDN to bucket URL (+ % # ? \\ control" +
        " characters, spaces at the ends of a name, non-ASCII)" +
        (count > stats.oddKeys.keys.length ? "; the first " + stats.oddKeys.keys.length + ":" : count ? ":" : "")
    );

    for (const key of stats.oddKeys.keys) lines.push("  " + JSON.stringify(key));
  }

  lines.push("");
  lines.push(stats.errors + " errors");

  return lines.join("\n");
}

// Whether the run should exit non-zero
function failed(stats, options) {
  if (stats.errors) return true;

  return !!(options && options.verify && (stats.missing || stats.mismatched));
}

module.exports = { backfill, summarise, failed, isOddKey };
