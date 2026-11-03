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

const shadow = require("storage/folder/shadow");

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

// Per call and for the cache, from the summed fields
function summarise(total) {
  const ops = {};

  shadow.OPS.forEach(function (op) {
    const histograms = { local: {}, s3: {} };
    const kinds = { mismatch: {}, transient: {}, s3error: {} };
    const counts = {};

    Object.keys(total).forEach(function (field) {
      const parts = field.split(":");

      if (parts[0] !== op) return;

      if ((parts[1] === "local" || parts[1] === "s3") && parts[2] === "le") {
        histograms[parts[1]][parts[3]] = total[field];
      } else if (parts.length === 3 && kinds[parts[1]]) {
        kinds[parts[1]][parts[2]] = total[field];
      } else if (parts.length === 2) {
        counts[parts[1]] = total[field];
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
      mismatchRate: sampled ? (counts.mismatched || 0) / sampled : 0,
      mismatchKinds: kinds.mismatch,
      transientKinds: kinds.transient,
      s3errorCodes: kinds.s3error,
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
    };
  });

  const hits = total["cache:hits"] || 0;
  const misses = total["cache:misses"] || 0;

  return {
    ops: ops,
    cache: {
      hits: hits,
      misses: misses,
      hitRate: hits + misses ? hits / (hits + misses) : null,
      fetchedBytes: total["cache:fetchedBytes"] || 0,
      evictions: total["cache:evictions"] || 0,
      changed: total["cache:changed"] || 0,
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

// The report as lines of text
function format(report) {
  const lines = [];
  const ops = Object.keys(report.ops);

  lines.push("Shadow reads, last " + report.hours + " hours (" + report.from + " to " + report.to + " UTC)");
  lines.push("");

  if (!ops.length) {
    lines.push("Nothing sampled. Is BLOT_FOLDER_SHADOW_RATE above 0, and BLOT_FOLDER_MIRROR on for some blogs?");
    return lines.join("\n");
  }

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

  ops.forEach(function (op) {
    const row = report.ops[op];

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

  const details = ops.filter(function (op) {
    const row = report.ops[op];
    return row.mismatched || row.transient || row.s3errors;
  });

  if (details.length) {
    lines.push("");
    lines.push("Mismatches, transient mismatches and S3 errors by kind:");

    details.forEach(function (op) {
      const row = report.ops[op];

      if (row.mismatched) lines.push("  " + op + " mismatch: " + breakdown(row.mismatchKinds));
      if (row.transient) lines.push("  " + op + " transient: " + breakdown(row.transientKinds));
      if (row.s3errors) lines.push("  " + op + " s3 errors: " + breakdown(row.s3errorCodes));
    });

    lines.push("  (paths are in the app's log: grep '" + shadow.LOG_PREFIX + "')");
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
      " changed under the index"
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

module.exports = { keysFor, sum, percentile, summarise, load, format };
