// Prints what the shadow reads of mirrored blog folders found over the last
// hours (#2258 Phase C): per call, how often S3 disagreed with the disk, how
// often it failed, and how long each side took, plus the content cache's hit
// rate. This is what decides whether S3 can become authoritative (Phase D)
// and how big the cache needs to be. See app/storage/folder/shadow.js for
// what is compared and how the counters are kept.
//
//   node scripts/storage/shadow-report.js [--hours 24] [--json]
//
// Read-only. Shadow reads are on when BLOT_FOLDER_SHADOW_RATE is above 0;
// counters are kept for 14 days. Latencies are read from fixed histograms, so
// a percentile is the bucket bound it falls under ("<=15" means at most
// 15 ms). Local and S3 latencies are for the same sampled calls; for
// createReadStream and serve both are a full read of the bytes again.
//
// For read, createReadStream, serve and ensureLocal the S3 latency is also
// split by how the content cache served it (hit, miss, or direct: not through
// the cache), and for the two streamed calls the time to first byte of each
// side is given, since that is what a visitor waits for. Hours recorded
// before the split have only the blended S3 latency, as does a read which
// failed before reaching the cache; the report counts those as unclassified.
//
// Blogs on S3 (BLOT_FOLDER_PRIMARY, #2258 Phase D) are shadowed the other way
// round: S3 answered the caller, and the disk copy is checked against it. They
// get a second table, "S3-primary vs disk copy", from the reverse:* counters;
// there a mismatch means S3 served something the disk would not have, and its
// S3 latencies are those of the caller's own reads. "disk copy behind" counts
// mismatches on a blog whose disk copy was already known to be behind S3.

const shadow = require("storage/folder/shadow");

// The calls whose S3 side goes through the content cache: only these get a
// cache outcome. Other calls (stat, listings) are metadata from the index.
const CACHE_AWARE = ["read", "createReadStream", "serve", "ensureLocal"];

const MAX_HOURS = shadow.TTL_SECONDS / 3600;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/storage/shadow-report.js [--hours N] [--json]");
  process.exit(2);
}

function parse(argv) {
  const options = { hours: 24, json: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--hours") options.hours = Number(argv[++i]);
    else usage("Unknown argument " + argv[i]);
  }

  if (!Number.isInteger(options.hours) || options.hours < 1 || options.hours > MAX_HOURS) {
    usage("--hours must be a whole number from 1 to " + MAX_HOURS);
  }

  return options;
}

// The Redis keys of the last `hours` hours, this one included
function keysFor(hours, now) {
  const keys = [];

  for (let i = hours - 1; i >= 0; i--) keys.push(shadow.hourKey(new Date(now.getTime() - i * 3600 * 1000)));

  return keys;
}

// Adds the hashes up, field by field
function sum(hashes) {
  const total = {};

  hashes.forEach(function (hash) {
    Object.keys(hash || {}).forEach(function (field) {
      total[field] = (total[field] || 0) + (Number(hash[field]) || 0);
    });
  });

  return total;
}

// The bucket bound under which a fraction p of the observations fall, as a
// string: "15" (at most 15 ms) or "inf" (over the last bound). null if none.
function percentile(histogram, p) {
  const bounds = shadow.BUCKETS.map(String).concat("inf");
  const total = bounds.reduce((n, bound) => n + (histogram[bound] || 0), 0);

  if (!total) return null;

  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;

  for (const bound of bounds) {
    seen += histogram[bound] || 0;
    if (seen >= rank) return bound;
  }

  return "inf";
}

function count(histogram) {
  return Object.keys(histogram).reduce((n, bound) => n + histogram[bound], 0);
}

// { count, p50, p95, p99 } of a histogram, or null if it has no observations
function stats(histogram) {
  const n = count(histogram);

  if (!n) return null;

  return { count: n, p50: percentile(histogram, 0.5), p95: percentile(histogram, 0.95), p99: percentile(histogram, 0.99) };
}

// Per call, for one direction: prefix is "" for the forward fields (a blog
// on disk, S3 checked against it) or shadow.REVERSE + ":" for the reverse
// ones (a blog on S3, its disk copy checked against it)
function summariseOps(total, prefix) {
  const ops = {};

  shadow.OPS.forEach(function (op) {
    const histograms = { local: {}, s3: {}, byCache: {}, ttfb: { local: {}, s3: {} } };
    const kinds = { mismatch: {}, transient: {}, s3error: {}, behind: {} };
    const counts = {};

    Object.keys(total).forEach(function (name) {
      if (prefix && name.indexOf(prefix) !== 0) return;

      const field = name.slice(prefix.length);
      const parts = field.split(":");

      if (parts[0] !== op) return;

      if ((parts[1] === "local" || parts[1] === "s3") && parts[2] === "le") {
        histograms[parts[1]][parts[3]] = total[name];
      } else if (parts[1] === "s3" && shadow.CACHE_OUTCOMES.indexOf(parts[2]) !== -1 && parts[3] === "le") {
        (histograms.byCache[parts[2]] = histograms.byCache[parts[2]] || {})[parts[4]] = total[name];
      } else if ((parts[1] === "local" || parts[1] === "s3") && parts[2] === "ttfb" && parts[3] === "le") {
        histograms.ttfb[parts[1]][parts[4]] = total[name];
      } else if (parts.length === 3 && kinds[parts[1]]) {
        kinds[parts[1]][parts[2]] = total[name];
      } else if (parts.length === 2) {
        counts[parts[1]] = total[name];
      }
    });

    if (!Object.keys(counts).length) return;

    const sampled = counts.sampled || 0;

    ops[op] = {
      sampled: sampled,
      matched: counts.matched || 0,
      mismatched: counts.mismatched || 0,
      transient: counts.transient || 0,
      s3errors: counts.s3error || 0,
      dropped: counts.dropped || 0,
      large: counts.large || 0,
      skipped: counts.skipped || 0,
      // Reverse only: mismatches on a blog whose disk copy was known to be
      // behind S3 (a failed copy, which the reconcile repairs)
      behind: counts.behind || 0,
      mismatchRate: sampled ? (counts.mismatched || 0) / sampled : 0,
      mismatchKinds: kinds.mismatch,
      transientKinds: kinds.transient,
      s3errorCodes: kinds.s3error,
      behindKinds: kinds.behind,
      local: {
        p50: percentile(histograms.local, 0.5),
        p95: percentile(histograms.local, 0.95),
        p99: percentile(histograms.local, 0.99),
      },
      s3: {
        p50: percentile(histograms.s3, 0.5),
        p95: percentile(histograms.s3, 0.95),
        p99: percentile(histograms.s3, 0.99),
      },
      // S3 latency by cache outcome: only the outcomes seen
      s3ByCache: {},
      // Samples of a cache-aware call whose S3 latency has no outcome: from
      // hours before the split, or a read which failed before the cache
      // (a missing file, say)
      s3Unclassified: 0,
      // Time to first byte, for the streamed calls: null where not recorded
      ttfb: { local: stats(histograms.ttfb.local), s3: stats(histograms.ttfb.s3) },
    };

    let split = 0;

    Object.keys(histograms.byCache).forEach(function (outcome) {
      const stat = stats(histograms.byCache[outcome]);
      ops[op].s3ByCache[outcome] = stat;
      split += stat.count;
    });

    if (CACHE_AWARE.indexOf(op) !== -1) ops[op].s3Unclassified = Math.max(0, count(histograms.s3) - split);
  });

  return ops;
}

// Per call in each direction, and for the cache, from the summed fields.
// ops is the forward direction (as before there were two), reverse.ops the
// reverse one.
function summarise(total) {
  const hits = total["cache:hits"] || 0;
  const misses = total["cache:misses"] || 0;

  return {
    ops: summariseOps(total, ""),
    reverse: { ops: summariseOps(total, shadow.REVERSE + ":") },
    cache: {
      hits: hits,
      misses: misses,
      hitRate: hits + misses ? hits / (hits + misses) : null,
      fetchedBytes: total["cache:fetchedBytes"] || 0,
      evictions: total["cache:evictions"] || 0,
      changed: total["cache:changed"] || 0,
      filled: total["cache:filled"] || 0,
    },
  };
}

// "2026-11-02 13:00" from a key's YYYYMMDDHH
function hourOf(key) {
  const h = key.slice(shadow.KEY_PREFIX.length);
  return h.slice(0, 4) + "-" + h.slice(4, 6) + "-" + h.slice(6, 8) + " " + h.slice(8, 10) + ":00";
}

// Reads and summarises the last `hours` hours from Redis
async function load(hours, now) {
  const client = require("models/client");
  const keys = keysFor(hours, now || new Date());
  const hashes = await Promise.all(keys.map((key) => client.hGetAll(key)));

  return Object.assign({ hours: hours, from: hourOf(keys[0]), to: hourOf(keys[keys.length - 1]) }, summarise(sum(hashes)));
}

function percent(fraction) {
  return (fraction * 100).toFixed(2) + "%";
}

function ms(bound) {
  if (bound === null) return "-";
  return bound === "inf" ? ">" + shadow.BUCKETS[shadow.BUCKETS.length - 1] : "<=" + bound;
}

function latencies(side) {
  return [side.p50, side.p95, side.p99].map(ms).join(" / ");
}

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function pad(value, width, left) {
  value = String(value);
  return left ? value.padEnd(width) : value.padStart(width);
}

function breakdown(kinds) {
  return Object.keys(kinds)
    .sort()
    .map((kind) => kind + " " + kinds[kind])
    .join(", ");
}

// Lines for one direction's calls: the table, the latency splits and the
// kinds of mismatch
function opsLines(ops) {
  const lines = [];
  const names = Object.keys(ops);

  const columns = [
    ["op", 22, true],
    ["sampled", 9],
    ["mismatch", 9],
    ["transient", 10],
    ["s3 errors", 10],
    ["dropped", 8],
    ["large", 6],
    ["local ms p50 / p95 / p99", 28],
    ["s3 ms p50 / p95 / p99", 28],
  ];

  lines.push(columns.map((c) => pad(c[0], c[1], c[2])).join(" "));

  names.forEach(function (op) {
    const row = ops[op];

    lines.push(
      [
        pad(op, 22, true),
        pad(row.sampled, 9),
        pad(percent(row.mismatchRate), 9),
        pad(row.transient, 10),
        pad(row.s3errors, 10),
        pad(row.dropped, 8),
        pad(row.large, 6),
        pad(latencies(row.local), 28),
        pad(latencies(row.s3), 28),
      ].join(" ")
    );
  });

  const splits = names.filter(function (op) {
    const row = ops[op];
    return Object.keys(row.s3ByCache).length || row.s3Unclassified || row.ttfb.local || row.ttfb.s3;
  });

  if (splits.length) {
    lines.push("");
    lines.push("S3 latency by content cache outcome, and time to first byte (ms p50 / p95 / p99):");

    splits.forEach(function (op) {
      const row = ops[op];
      const outcomes = shadow.CACHE_OUTCOMES.filter((outcome) => row.s3ByCache[outcome]).map(
        (outcome) => outcome + " " + row.s3ByCache[outcome].count + " " + latencies(row.s3ByCache[outcome])
      );

      if (row.s3Unclassified) outcomes.push(row.s3Unclassified + " unclassified");
      if (outcomes.length) lines.push("  " + pad(op, 17, true) + " s3: " + outcomes.join("; "));

      if (row.ttfb.local || row.ttfb.s3) {
        lines.push(
          "  " + pad("", 17, true) + " first byte: local " + (row.ttfb.local ? latencies(row.ttfb.local) : "-") + "; s3 " + (row.ttfb.s3 ? latencies(row.ttfb.s3) : "-")
        );
      }
    });
  }

  const details = names.filter(function (op) {
    const row = ops[op];
    return row.mismatched || row.transient || row.s3errors || row.behind;
  });

  if (details.length) {
    lines.push("");
    lines.push("Mismatches, transient mismatches and S3 errors by kind:");

    details.forEach(function (op) {
      const row = ops[op];

      if (row.mismatched) lines.push("  " + op + " mismatch: " + breakdown(row.mismatchKinds));
      if (row.transient) lines.push("  " + op + " transient: " + breakdown(row.transientKinds));
      if (row.behind) lines.push("  " + op + " disk copy behind: " + breakdown(row.behindKinds));
      if (row.s3errors) lines.push("  " + op + " s3 errors: " + breakdown(row.s3errorCodes));
    });

    lines.push("  (paths are in the app's log: grep '" + shadow.LOG_PREFIX + "')");
  }

  return lines;
}

// The report as lines of text
function format(report) {
  const lines = [];
  const forward = report.ops;
  const reverse = (report.reverse && report.reverse.ops) || {};

  lines.push("Shadow reads, last " + report.hours + " hours (" + report.from + " to " + report.to + " UTC)");
  lines.push("");

  if (!Object.keys(forward).length && !Object.keys(reverse).length) {
    lines.push("Nothing sampled. Is BLOT_FOLDER_SHADOW_RATE above 0, and BLOT_FOLDER_MIRROR on for some blogs?");
    return lines.join("\n");
  }

  lines.push("Blogs on disk: S3 checked against the disk");
  lines.push("");

  if (Object.keys(forward).length) lines.push(...opsLines(forward));
  else lines.push("Nothing sampled.");

  if (Object.keys(reverse).length) {
    lines.push("");
    lines.push("S3-primary vs disk copy: blogs on S3, the disk copy checked against S3 (mismatch = S3 served what the disk would not have)");
    lines.push("");
    lines.push(...opsLines(reverse));
  }

  const cache = report.cache;

  lines.push("");
  lines.push(
    "Content cache: " +
      cache.hits +
      " hits, " +
      cache.misses +
      " misses" +
      (cache.hitRate === null ? "" : " (" + percent(cache.hitRate) + " hits)") +
      ", " +
      megabytes(cache.fetchedBytes) +
      " fetched from S3, " +
      cache.evictions +
      " evictions, " +
      cache.changed +
      " changed under the index, " +
      cache.filled +
      " filled by writes"
  );

  return lines.join("\n");
}

async function main() {
  const options = parse(process.argv.slice(2));
  const report = await load(options.hours);

  console.log(options.json ? JSON.stringify(report, null, 2) : format(report));
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { keysFor, sum, percentile, summarise, summariseOps, load, format };
