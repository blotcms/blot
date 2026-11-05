// Prints the soak table of the folder cutover PR (#2258): what the shadow
// reads of mirrored blog folders found, as Markdown to paste between
// <!-- soak-numbers:start --> and <!-- soak-numbers:end -->, in the columns
// of the git store's cutover PR. Four parts:
//
//   operations   per call: disk and S3 p50 / p95, S3 requests per call
//                (estimated, see below) and n. Then the byte reads' S3 latency
//                by content cache outcome (hit, miss, direct) and the time to
//                first byte of serve and createReadStream. Read from the
//                shadow counters (scripts/storage/shadow-report.js)
//   memory       p95 of each unit's memory (anon + shmem) in the soak window
//                and in a window before it, from the host's unit-mem.log
//   index        Redis memory of the models/file index, estimated
//   cost         S3 storage and requests as a % of the data volume's monthly
//                cost, and egress
//
//   node scripts/storage/folder-soak-report.js [--hours 72 | --since <ISO>]
//     [--json] [--rate <fraction>]
//     [--unit-mem <file> --before <ISO>/<ISO>]
//     [--no-index] [--sample 2000] [--scan-count 1000] [--max-scan-calls 5000]
//     [--stored-bytes N] [--ebs-gb N --ebs-price-gb-month N]
//     [--writes-per-day N]
//     [--s3-price-gb-month N] [--s3-put-per-1000 N] [--s3-get-per-1000 N]
//
// Read-only, and safe to run in production in the app container as the app's
// user (docker exec -u 1000 <container> node scripts/storage/folder-soak-report.js ...).
// It only reads Redis: the shadow counters, and for the index SCAN, TYPE,
// MEMORY USAGE and HGET. The unit-mem log is a file you copy off the host
// (/var/instance-ssd/logs/unit-mem.log; one line per container per sample,
// written by config/host/scripts/unit-mem-log.sh) and pass with --unit-mem;
// the script runs in the container, so copy the log in too, or run the
// memory part where the file is. Without --unit-mem the memory part is left
// out.
//
// Window: --hours N back from now, or --since <ISO> (at most as far back as
// the counters are kept). The soak window for memory is the same.
//
// S3 requests are ESTIMATED: shadow reads don't count them. A metadata call
// (stat, exists, list, listNames, listAll, resolveCaseInsensitive) is answered
// from the Redis index and costs none. For read, createReadStream, serve and
// ensureLocal a content cache hit costs none and a miss or a direct read costs
// one GET, so requests per call = (miss + direct) / (hit + miss + direct)
// over the samples which have an outcome.
//
// Cost: S3 storage is --stored-bytes (the S3 folder prefix total; if omitted,
// the sum of the index's per-blog totals when the index is scanned). Reads
// per month are the sampled calls divided by the sample rate (--rate, or
// config.folder_shadow.rate), scaled to a month, times the GET estimate.
// Writes per month are --writes-per-day, or the content cache's "filled"
// counter (one per mirrored write of a file under the cache's size limit, so
// a lower bound) per day. The % is of --ebs-gb * --ebs-price-gb-month.
// Egress: folder files the CDN pulls from S3 cost the same per GB as from EC2
// today, so it is unchanged.
//
// Index memory: SCAN for blog:*:file:* (read-only; it walks the whole
// keyspace in --scan-count steps, at most --max-scan-calls of them), then a
// random --sample of the keys, spread over the five kinds of key, each
// checked with TYPE before MEMORY USAGE, so at most --sample MEMORY USAGE
// calls. Memory per kind is the number of keys times the sample's mean, with a
// ~95% margin from the sample's spread.

const readline = require("readline");
const fs = require("fs");

// S3 Standard list prices, us-west-2 (USD). The only place they're written.
const S3_PRICES = { gbMonth: 0.023, putPer1000: 0.005, getPer1000: 0.0004 };

const GIB = 1024 * 1024 * 1024;
const HOURS_PER_MONTH = 730;
const CACHE_AWARE = ["read", "createReadStream", "serve", "ensureLocal"];
const TTFB_OPS = ["createReadStream", "serve"];
const OUTCOMES = ["hit", "miss", "direct"];
const KINDS = ["dir", "lower", "names", "paths", "totals"];
const KIND_TYPES = { dir: "hash", lower: "hash", names: "zset", paths: "zset", totals: "hash" };

// --- arguments ---------------------------------------------------------

const NUMERIC = {
  "--rate": "rate",
  "--sample": "sample",
  "--scan-count": "scanCount",
  "--max-scan-calls": "maxScanCalls",
  "--stored-bytes": "storedBytes",
  "--ebs-gb": "ebsGb",
  "--ebs-price-gb-month": "ebsPrice",
  "--writes-per-day": "writesPerDay",
  "--s3-price-gb-month": "s3GbMonth",
  "--s3-put-per-1000": "s3Put",
  "--s3-get-per-1000": "s3Get",
};

// "2026-10-30T00:00:00Z/2026-11-02T00:00:00Z" (or with "..") as { from, to }
function parseRange(text) {
  const parts = String(text || "").split(/\/|\.\./);
  const from = new Date(parts[0]);
  const to = new Date(parts[1]);

  if (parts.length !== 2 || isNaN(from) || isNaN(to) || from >= to) {
    throw new Error("--before must be <ISO>/<ISO>, earlier first");
  }

  return { from: from, to: to };
}

function parseArgs(argv) {
  const options = { hours: null, since: null, json: false, index: true, sample: 2000, scanCount: 1000, maxScanCalls: 5000 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--json") options.json = true;
    else if (arg === "--no-index") options.index = false;
    else if (arg === "--hours") options.hours = Number(argv[++i]);
    else if (arg === "--since") options.since = new Date(argv[++i]);
    else if (arg === "--unit-mem") options.unitMem = argv[++i];
    else if (arg === "--before") options.before = parseRange(argv[++i]);
    else if (NUMERIC[arg]) options[NUMERIC[arg]] = Number(argv[++i]);
    else throw new Error("Unknown argument " + arg);
  }

  if (options.hours !== null && options.since) throw new Error("Give --hours or --since, not both");
  if (options.hours === null && !options.since) options.hours = 24;
  if (options.since && isNaN(options.since)) throw new Error("--since must be an ISO date");
  if (options.hours !== null && !(options.hours >= 1)) throw new Error("--hours must be at least 1");

  Object.keys(NUMERIC).forEach(function (flag) {
    const name = NUMERIC[flag];
    if (name in options && !(options[name] >= 0)) throw new Error(flag + " must be a number");
  });

  if (options.before && !options.unitMem) throw new Error("--before needs --unit-mem");
  if (options.unitMem && !options.before) throw new Error("--unit-mem needs --before <ISO>/<ISO>");

  return options;
}

// --- operations --------------------------------------------------------

// The estimated S3 GETs per call of a summarised op (see the header): null
// where no sample has a cache outcome
function requestsPerOp(row) {
  const by = row.s3ByCache || {};
  const n = {};
  let total = 0;

  OUTCOMES.forEach(function (outcome) {
    n[outcome] = by[outcome] ? by[outcome].count : 0;
    total += n[outcome];
  });

  return total ? (n.miss + n.direct) / total : null;
}

function bound(value) {
  return value === null || value === undefined ? "-" : value === "inf" ? ">max" : "<=" + value;
}

function pair(side) {
  return side ? bound(side.p50) + " / " + bound(side.p95) : "-";
}

function requestsText(op, row) {
  if (CACHE_AWARE.indexOf(op) === -1) return "0";

  const per = requestsPerOp(row);

  return per === null ? "-" : per.toFixed(2);
}

// Markdown lines for the per-operation tables, from shadow-report's summary
function operationsMarkdown(summary) {
  const ops = Object.keys(summary.ops);
  const lines = [];

  lines.push("| Operation | Disk p50 / p95 (ms) | S3 p50 / p95 (ms) | S3 requests per call (estimated) | n |");
  lines.push("| --- | --- | --- | --- | --- |");

  ops.forEach(function (op) {
    const row = summary.ops[op];
    lines.push("| `" + op + "` | " + pair(row.local) + " | " + pair(row.s3) + " | " + requestsText(op, row) + " | " + row.sampled + " |");
  });

  const byteOps = ops.filter((op) => CACHE_AWARE.indexOf(op) !== -1 && Object.keys(summary.ops[op].s3ByCache).length);

  if (byteOps.length) {
    lines.push("");
    lines.push("S3 byte reads by content cache outcome, p50 / p95 (ms) and n:");
    lines.push("");
    lines.push("| Operation | S3 hit | S3 miss | S3 direct |");
    lines.push("| --- | --- | --- | --- |");

    byteOps.forEach(function (op) {
      const by = summary.ops[op].s3ByCache;
      const cells = OUTCOMES.map((outcome) => (by[outcome] ? pair(by[outcome]) + " (n " + by[outcome].count + ")" : "-"));
      lines.push("| `" + op + "` | " + cells.join(" | ") + " |");
    });
  }

  const ttfb = TTFB_OPS.filter((op) => summary.ops[op] && (summary.ops[op].ttfb.local || summary.ops[op].ttfb.s3));

  if (ttfb.length) {
    lines.push("");
    lines.push("Time to first byte, p50 / p95 (ms):");
    lines.push("");
    lines.push("| Operation | Disk | S3 |");
    lines.push("| --- | --- | --- |");

    ttfb.forEach(function (op) {
      const row = summary.ops[op];
      lines.push("| `" + op + "` | " + pair(row.ttfb.local) + " | " + pair(row.ttfb.s3) + " |");
    });
  }

  return lines;
}

// --- unit memory -------------------------------------------------------

// { time (ms), name, held (anon + shmem, bytes) } of a line of unit-mem.log,
// or null for a line without those (a host line, a blank, a torn write)
function parseUnitMemLine(line) {
  const parts = String(line).trim().split(/\s+/);

  if (parts.length < 3) return null;

  const time = Date.parse(parts[0]);

  if (isNaN(time)) return null;

  const fields = {};

  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq > 0) fields[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
  }

  if (!fields.name || fields.name === "host") return null;
  if (!/^\d+$/.test(fields.anon || "") || !/^\d+$/.test(fields.shmem || "")) return null;

  return { time: time, name: fields.name, held: Number(fields.anon) + Number(fields.shmem) };
}

// Nearest-rank percentile of an unsorted array of numbers; null if empty
function nearestRank(values, p) {
  if (!values.length) return null;

  const sorted = values.slice().sort((a, b) => a - b);

  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

// Reads the lines of a log (an iterable, sync or async, of strings) and gives,
// for each container, the p95 of anon + shmem in each window ({ from, to }
// Dates, to exclusive): { "blot-blue": { before: { p95, samples }, soak } }
async function unitMemory(lines, windows) {
  const values = {};

  for await (const line of lines) {
    const sample = parseUnitMemLine(line);

    if (!sample) continue;

    Object.keys(windows).forEach(function (label) {
      const w = windows[label];

      if (!w || sample.time < w.from.getTime() || sample.time >= w.to.getTime()) return;

      values[sample.name] = values[sample.name] || {};
      (values[sample.name][label] = values[sample.name][label] || []).push(sample.held);
    });
  }

  const result = {};

  Object.keys(values)
    .sort()
    .forEach(function (name) {
      result[name] = {};
      Object.keys(windows).forEach(function (label) {
        const list = values[name][label] || [];
        result[name][label] = { p95: nearestRank(list, 0.95), samples: list.length };
      });
    });

  return result;
}

function fileLines(path) {
  return readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
}

function mib(bytes) {
  return bytes === null || bytes === undefined ? "-" : (bytes / (1024 * 1024)).toFixed(0) + " MiB";
}

function signedPercent(from, to) {
  if (!from || to === null || to === undefined) return "-";

  const change = ((to - from) / from) * 100;

  return (change >= 0 ? "+" : "") + change.toFixed(0) + "%";
}

function memoryMarkdown(memory) {
  const names = Object.keys(memory);

  if (!names.length) return ["No samples for the windows in the unit-mem log."];

  const lines = ["| Memory per unit (anon + shmem), p95 | Before | Soak | Change | Samples |", "| --- | --- | --- | --- | --- |"];

  names.forEach(function (name) {
    const before = memory[name].before;
    const soak = memory[name].soak;

    lines.push(
      "| `" + name + "` | " + mib(before && before.p95) + " | " + mib(soak && soak.p95) + " | " + signedPercent(before && before.p95, soak && soak.p95) +
        " | " + (before ? before.samples : 0) + " / " + (soak ? soak.samples : 0) + " |"
    );
  });

  return lines;
}

// --- index memory ------------------------------------------------------

function kindOf(key) {
  const match = /^blog:[^:]+:file:(dir|lower|names|paths|totals)(:|$)/.exec(key);

  return match ? match[1] : null;
}

// Walks the keyspace with SCAN (read-only) counting blog:*:file:* keys by
// kind, and keeps a uniform random sample of each kind (reservoir sampling)
// and every totals key. The client needs only sendCommand.
async function scanIndexKeys(client, options) {
  const perKind = Math.max(1, Math.floor(options.sample / KINDS.length));
  const counts = {};
  const samples = {};
  const totals = [];
  const random = options.random || Math.random;
  let cursor = "0";
  let calls = 0;

  KINDS.forEach(function (kind) {
    counts[kind] = 0;
    samples[kind] = [];
  });

  do {
    const reply = await client.sendCommand(["SCAN", cursor, "MATCH", "blog:*:file:*", "COUNT", String(options.scanCount)]);

    cursor = String(reply[0]);
    calls++;

    reply[1].forEach(function (raw) {
      const key = String(raw);
      const kind = kindOf(key);

      if (!kind) return;

      counts[kind]++;

      if (kind === "totals") totals.push(key);

      if (samples[kind].length < perKind) samples[kind].push(key);
      else {
        const j = Math.floor(random() * counts[kind]);
        if (j < perKind) samples[kind][j] = key;
      }
    });
  } while (cursor !== "0" && calls < options.maxScanCalls);

  return { counts: counts, samples: samples, totals: totals, complete: cursor === "0", calls: calls };
}

// Estimated bytes of the whole index and by kind: keys of the right type
// only (TYPE first), MEMORY USAGE on those, the mean times the key count.
// SCAN may return a key twice, which only nudges the counts.
async function estimateIndexMemory(client, options) {
  const scan = await scanIndexKeys(client, options);
  const kinds = {};
  let memoryCalls = 0;
  let wrongType = 0;
  let total = 0;
  let variance = 0;

  for (const kind of KINDS) {
    const sizes = [];

    for (const key of scan.samples[kind]) {
      if (String(await client.sendCommand(["TYPE", key])) !== KIND_TYPES[kind]) {
        wrongType++;
        continue;
      }

      const bytes = await client.sendCommand(["MEMORY", "USAGE", key]);
      memoryCalls++;

      if (bytes !== null && bytes !== undefined) sizes.push(Number(bytes));
    }

    const n = sizes.length;
    const count = scan.counts[kind];
    const mean = n ? sizes.reduce((a, b) => a + b, 0) / n : 0;
    const spread = n > 1 ? sizes.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
    // The variance of the extrapolated total; none if the whole kind was measured
    const kindVariance = n >= count ? 0 : count * count * (spread / Math.max(n, 1));

    kinds[kind] = { keys: count, sampled: n, bytes: mean * count };
    total += mean * count;
    variance += kindVariance;
  }

  // The folder's size, from the per-blog totals: the default for --stored-bytes
  let storedBytes = 0;

  for (let i = 0; i < scan.totals.length; i += 500) {
    const values = await Promise.all(scan.totals.slice(i, i + 500).map((key) => client.sendCommand(["HGET", key, "bytes"])));
    values.forEach((value) => (storedBytes += Number(value) || 0));
  }

  return {
    bytes: total,
    margin: 1.96 * Math.sqrt(variance),
    kinds: kinds,
    blogs: scan.totals.length,
    storedBytes: storedBytes,
    memoryCalls: memoryCalls,
    wrongType: wrongType,
    scanCalls: scan.calls,
    complete: scan.complete,
  };
}

function indexMarkdown(index) {
  const lines = [
    "| `models/file` index, Redis memory (estimated) | |",
    "| --- | --- |",
    "| Total | " + mib(index.bytes) + " (about " + (index.bytes ? ((index.margin / index.bytes) * 100).toFixed(0) : 0) + "% either way) |",
  ];

  KINDS.forEach(function (kind) {
    const k = index.kinds[kind];
    lines.push("| `" + kind + "` keys | " + k.keys + " keys, " + mib(k.bytes) + " |");
  });

  lines.push(
    "| How | " + index.memoryCalls + " `MEMORY USAGE` calls on a random sample of the keys (each checked with `TYPE` first, " + index.wrongType +
      " of the wrong type skipped), times the key count of its kind; " + index.scanCalls + " `SCAN` calls, " + index.blogs + " blogs" +
      (index.complete ? "" : ", stopped early, so key counts are lower bounds") + " |"
  );

  return lines;
}

// --- cost --------------------------------------------------------------

// Monthly S3 cost from the inputs, and as a % of the data volume's cost.
// summary is shadow-report's; hours the length of the window.
function costEstimate(summary, hours, options, storedBytes) {
  const prices = {
    gbMonth: options.s3GbMonth !== undefined ? options.s3GbMonth : S3_PRICES.gbMonth,
    putPer1000: options.s3Put !== undefined ? options.s3Put : S3_PRICES.putPer1000,
    getPer1000: options.s3Get !== undefined ? options.s3Get : S3_PRICES.getPer1000,
  };
  const rate = options.rate;

  let readsPerMonth = 0;
  let getsPerMonth = 0;
  // Byte reads whose GETs can't be estimated: their ops had no cache
  // outcomes in the window (hours from before the split), so not counted as 0
  let unclassifiedPerMonth = 0;

  CACHE_AWARE.forEach(function (op) {
    const row = summary.ops[op];

    if (!row || !(rate > 0)) return;

    // A dropped shadow was selected by the rate too, then skipped for
    // concurrency, so it counts towards the volume of calls
    const calls = ((row.sampled + (row.dropped || 0)) / rate / hours) * HOURS_PER_MONTH;
    const per = requestsPerOp(row);

    readsPerMonth += calls;

    if (per === null) unclassifiedPerMonth += calls;
    else getsPerMonth += calls * per;
  });

  const writesPerDay = options.writesPerDay !== undefined ? options.writesPerDay : (summary.cache.filled / hours) * 24;
  const putsPerMonth = (writesPerDay * HOURS_PER_MONTH) / 24;

  const storage = storedBytes ? (storedBytes / GIB) * prices.gbMonth : null;
  const requests = (putsPerMonth / 1000) * prices.putPer1000 + (getsPerMonth / 1000) * prices.getPer1000;
  const total = storage === null ? null : storage + requests;
  const ebs = options.ebsGb && options.ebsPrice ? options.ebsGb * options.ebsPrice : null;

  return {
    prices: prices,
    rate: rate || null,
    storedBytes: storedBytes || null,
    readsPerMonth: readsPerMonth,
    getsPerMonth: getsPerMonth,
    unclassifiedPerMonth: unclassifiedPerMonth,
    writesPerDay: writesPerDay,
    writesFrom: options.writesPerDay !== undefined ? "from --writes-per-day" : "cache filled counter, a lower bound",
    putsPerMonth: putsPerMonth,
    storage: storage,
    requests: requests,
    total: total,
    ebs: ebs,
    percentOfEbs: total !== null && ebs ? (total / ebs) * 100 : null,
    storagePercentOfEbs: storage !== null && ebs ? (storage / ebs) * 100 : null,
    requestsPercentOfEbs: ebs ? (requests / ebs) * 100 : null,
  };
}

function compact(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : n.toFixed(0);
}

function costMarkdown(cost) {
  const lines = ["| Cost | |", "| --- | --- |"];

  if (cost.percentOfEbs !== null) {
    lines.push("| S3 (storage + requests), as % of the data volume's monthly cost | about " + cost.percentOfEbs.toFixed(1) + "% |");
    lines.push("| of which storage / requests | " + cost.storagePercentOfEbs.toFixed(1) + "% / " + cost.requestsPercentOfEbs.toFixed(1) + "% |");
  } else if (cost.total !== null) {
    lines.push("| S3 (storage + requests), as % of the data volume's monthly cost | not known: give --ebs-gb and --ebs-price-gb-month |");
  } else {
    lines.push("| S3 storage + requests | not known: give --stored-bytes (or scan the index) |");
  }

  lines.push(
    "| Request rates (estimated) | " + compact(cost.writesPerDay) + " writes/day (" + cost.writesFrom + "); " + compact(cost.getsPerMonth) +
      " GETs/month of " + compact(cost.readsPerMonth) + " byte reads/month, from the shadow sample" +
      (cost.rate ? " at rate " + cost.rate : "") +
      (cost.unclassifiedPerMonth
        ? "; GETs unknown for " + compact(cost.unclassifiedPerMonth) + " reads/month with no cache outcomes, left out of the request cost"
        : "") +
      " |"
  );
  lines.push("| Egress | unchanged (the CDN pulls a folder file from S3 at the same price per GB as from EC2 today) |");

  return lines;
}

// --- the report --------------------------------------------------------

function markdown(report) {
  const lines = [
    "> Shadow reads " + report.from + " to " + report.to + " UTC (" + report.windowHours.toFixed(1) + " h). Times are server-side; \"<=N\" is the " +
      "histogram bucket a percentile falls under. S3 requests are estimated from cache outcomes, as shadow reads don't count them.",
    "",
  ];

  if (!Object.keys(report.summary.ops).length) {
    lines.push("Nothing sampled in this window. Is BLOT_FOLDER_SHADOW_RATE above 0, and BLOT_FOLDER_MIRROR on for some blogs?", "");
  } else {
    lines.push(...operationsMarkdown(report.summary), "");
  }

  if (report.memory) lines.push(...memoryMarkdown(report.memory), "");
  if (report.index) lines.push(...indexMarkdown(report.index), "");
  lines.push(...costMarkdown(report.cost));

  return lines.join("\n");
}

async function build(options, now) {
  const shadowReport = require("./shadow-report");
  const shadow = require("storage/folder/shadow");
  const config = require("config");

  now = now || new Date();

  const maxHours = shadow.TTL_SECONDS / 3600;
  // Every UTC hour bucket the window touches, the one --since falls in included
  const hours = options.hours !== null ? Math.floor(options.hours) : Math.floor(now / 3600000) - Math.floor(options.since / 3600000) + 1;

  if (hours < 1 || hours > maxHours) throw new Error("The window must be 1 to " + maxHours + " hours (the counters are kept that long)");

  options.rate = options.rate !== undefined ? options.rate : Number(config.folder_shadow.rate) || 0;

  const summary = await shadowReport.load(hours, now);
  const first = new Date(summary.from.replace(" ", "T") + ":00Z");
  const start = options.since && options.since > first ? options.since : first;
  const windowHours = Math.max(1 / 60, (now - first) / 3600000);
  const report = { from: summary.from, to: summary.to, windowHours: windowHours, rate: options.rate, summary: summary };

  if (options.unitMem) {
    report.memory = await unitMemory(fileLines(options.unitMem), {
      before: options.before,
      soak: { from: start, to: new Date(now.getTime() + 1) },
    });
  }

  if (options.index) report.index = await estimateIndexMemory(require("models/client"), options);

  const stored = options.storedBytes !== undefined ? options.storedBytes : report.index ? report.index.storedBytes : 0;

  report.cost = costEstimate(summary, windowHours, options, stored);

  return report;
}

async function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message + "\n\nSee the header of scripts/storage/folder-soak-report.js for usage.");
    process.exit(2);
  }

  const report = await build(options);

  console.log(options.json ? JSON.stringify(report, null, 2) : markdown(report));
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

module.exports = {
  S3_PRICES,
  parseArgs,
  parseRange,
  requestsPerOp,
  operationsMarkdown,
  parseUnitMemLine,
  nearestRank,
  unitMemory,
  memoryMarkdown,
  kindOf,
  scanIndexKeys,
  estimateIndexMemory,
  indexMarkdown,
  costEstimate,
  costMarkdown,
  markdown,
  build,
};
