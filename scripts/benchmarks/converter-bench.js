#!/usr/bin/env node
"use strict";

/**
 * Per-converter build-time micro-benchmark: times N conversions of a
 * converter's own existing test fixtures using its actual `read(blog, path,
 * callback)` function directly - no full blog/Redis/rebuild machinery, since
 * a converter's `read` only touches the blog's folder (through storage/folder:
 * the storage bucket and Redis, which the workflow provides) and, for some
 * converters (docx/odt), shells out to pandoc/soffice.
 *
 * Used by .github/workflows/benchmarks-converters.yml, which only invokes
 * this for converters whose directory actually changed.
 *
 *   node scripts/benchmarks/converter-bench.js --converter markdown --n 300
 *   node scripts/benchmarks/converter-bench.js --converter img --converter docx --output /tmp/result.json
 *   node scripts/benchmarks/converter-bench.js --converter markdown --corpus typical --sandbox
 *
 * --corpus tests (the default) times the converter's own test fixtures, and
 * --corpus typical the realistic documents converter-corpus.js generates
 * (both can be given). --sandbox runs the sandbox jobs (pandoc, sharp,
 * exiftool) through a local broker, one process each, as production does
 * minus nsjail (lib/local-sandbox.js); without it they run in-process, which
 * leaves out the start of every job.
 *
 * Requires NODE_PATH=app (same as the rest of scripts/benchmarks) so
 * `require("helper/...")`, `require("config")`, `require("build/...")`
 * resolve.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");

// The local broker, with --sandbox (lib/local-sandbox.js)
let sandbox = null;

// Converters that use the assets bucket (grep app/build/converters for storage/assets)
const NEEDS_BUCKET = ["docx", "odt", "img", "gdoc"];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function argAll(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// The pandoc the converters run (app/sandbox/jobs/pandoc.js picks the same)
function pandocVersion() {
  const { execFileSync } = require("child_process");
  const bin =
    process.env.BLOT_PANDOC_PATH ||
    (fs.existsSync("/usr/local/bin/pandoc") ? "/usr/local/bin/pandoc" : "pandoc");
  try {
    return execFileSync(bin, ["--version"]).toString().split("\n")[0];
  } catch (err) {
    return "no pandoc";
  }
}

function listConverters() {
  const dir = path.resolve(__dirname, "../../app/build/converters");
  return fs
    .readdirSync(dir)
    .filter((name) => {
      const full = path.join(dir, name);
      return fs.statSync(full).isDirectory() && name !== "tests";
    })
    .sort();
}

function collectFixtures(converterName, converterModule) {
  const testsDir = path.resolve(
    __dirname,
    `../../app/build/converters/${converterName}/tests`
  );

  if (!fs.existsSync(testsDir)) return [];

  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  walk(testsDir);

  const fileSet = new Set(files);

  // Only files the converter itself claims to handle. Exclude test scripts
  // outright, and exclude a ".html" file specifically when it's the
  // "expected output" companion for another fixture in the same convention
  // used across app/build/converters/*/tests (e.g. metadata.txt +
  // metadata.txt.html) - but keep standalone .html fixtures (the html
  // converter's own tests/fixtures/*.html, which have no such companion).
  return files.filter((f) => {
    if (f.endsWith(".js")) return false;
    if (f.endsWith(".html") && fileSet.has(f.slice(0, -".html".length))) {
      return false;
    }
    try {
      return converterModule.is(f);
    } catch (err) {
      return false;
    }
  });
}

// options: { label, fixtures } - fixtures defaults to the converter's own
// tests, label (the result's name) to the converter's name
async function benchmarkConverter(name, n, options = {}) {
  const converterModule = require(`../../app/build/converters/${name}`);
  const label = options.label || name;
  const fixtures = (options.fixtures || collectFixtures(name, converterModule)).filter((f) =>
    converterModule.is(f)
  );

  if (!fixtures.length) {
    return { name: label, skipped: true, reason: "no usable fixtures found" };
  }

  const folder = require("../../app/storage/folder");

  // A throwaway blog ID so `read(blog, path, callback)` (which reads the
  // blog's folder through storage/folder) has somewhere real to read from,
  // without needing Blog.create.
  const blogID = `converter-bench-${label}`;
  const blog = {
    id: blogID,
    imageExif: false,
    // Only the fields converters actually read directly (grepped across
    // app/build/converters/*/index.js and their helper modules) - avoids
    // pulling in the real Blog model defaults, which touch Redis on
    // require and aren't needed for a pure conversion-timing benchmark.
    plugins: {
      linebreaks: { enabled: false },
      katex: { enabled: false },
      callouts: { enabled: false },
    },
  };

  // Copy every fixture into the fake blog folder, so read() finds them at a
  // normal-looking blog-relative path.
  const fixtureTasks = [];

  for (let i = 0; i < fixtures.length; i++) {
    const targetName = `fixture-${i}${path.extname(fixtures[i])}`;
    await folder.writeFrom(blogID, `/${targetName}`, fixtures[i]);
    fixtureTasks.push(`/${targetName}`);
  }

  const durationsMs = [];
  const perFixture = [];
  const jobsBefore = sandbox ? sandbox.jobs() : 0;
  let errorCount = 0;
  let lastErrorMessage = null;
  let peakRssMb = 0;

  for (let i = 0; i < n; i++) {
    const fixtureIndex = i % fixtureTasks.length;
    const blogPath = fixtureTasks[fixtureIndex];

    const startedAt = performance.now();
    const err = await new Promise((resolve) => {
      converterModule.read(blog, blogPath, (err) => {
        resolve(err || null);
      });
    });
    const elapsedMs = performance.now() - startedAt;

    // A callback error (missing tool, malformed fixture) is not a fast
    // successful conversion - blending its elapsed time into the timing
    // array would make a broken converter look like a speedup and poison
    // the rolling baseline. Bucket errors into their own count/message
    // instead of the timing numbers.
    if (err) {
      errorCount++;
      lastErrorMessage = err.message || String(err);
    } else {
      durationsMs.push(elapsedMs);
      (perFixture[fixtureIndex] = perFixture[fixtureIndex] || []).push(elapsedMs);
    }

    // KNOWN LIMITATION: this is the absolute RSS of the current (shared)
    // process, not memory attributable to this converter alone. When
    // benchmarkConverter() is called more than once in the same run (a
    // shared-dependency change triggers several converters, or a manual run
    // selects several - see main() below), a later converter's "peak RSS"
    // includes memory retained by earlier converters' modules/allocations,
    // which can falsely attribute a memory regression to the wrong
    // converter. Deliberately not fixed here (would mean forking a child
    // process per converter via child_process.fork/execFileSync and reading
    // *its* RSS) - not worth the added complexity for a benchmark whose
    // primary signal is timing, not memory; see also the README's
    // "Per-converter benchmarks" section.
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb > peakRssMb) peakRssMb = rssMb;
  }

  await folder.removeAll(blogID);

  const sandboxJobs = sandbox ? sandbox.jobs() - jobsBefore : null;

  if (!durationsMs.length) {
    return {
      name: label,
      skipped: true,
      reason: `all ${n} conversion(s) errored - last error: ${lastErrorMessage}`,
      error_count: errorCount,
    };
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = durationsMs.reduce((a, b) => a + b, 0);

  return {
    name: label,
    skipped: false,
    fixture_count: fixtures.length,
    conversions: n,
    error_count: errorCount,
    // Sandbox jobs started per conversion (--sandbox only)
    sandbox_jobs_per_conversion: sandboxJobs === null ? null : sandboxJobs / n,
    timing_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      mean: sum / durationsMs.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    },
    peak_rss_mb: Math.round(peakRssMb),
    // p50 per fixture, by file name: a corpus mixes short and long inputs,
    // whose times the overall percentiles blend
    fixture_p50_ms: Object.fromEntries(
      fixtures.map((f, i) => [
        path.basename(f),
        perFixture[i] ? percentile([...perFixture[i]].sort((a, b) => a - b), 50) : null,
      ])
    ),
  };
}

async function main() {
  let converters = argAll("--converter");
  const n = Number(arg("--n", 300));
  const output = arg("--output");
  const corpora = argAll("--corpus");
  if (!corpora.length) corpora.push("tests");
  for (const corpus of corpora) {
    if (corpus !== "tests" && corpus !== "typical") throw new Error(`unknown corpus: ${corpus}`);
  }

  if (!converters.length) {
    converters = listConverters();
  }

  // Before anything loads config, which reads BLOT_SANDBOX_SOCKET once
  if (process.argv.includes("--sandbox")) sandbox = await require("./lib/local-sandbox").start();

  console.log(
    `[converter-bench] benchmarking: ${converters.join(", ")} (n=${n}, corpus=${corpora.join("+")}, ` +
      `${sandbox ? "jobs through a local broker" : "jobs in-process"}, ${pandocVersion()})`
  );

  // docx, odt and img upload what they extract or convert to the assets
  // bucket (MinIO, started by the workflow)
  if (converters.some((name) => NEEDS_BUCKET.includes(name))) {
    await require("../tests/util/bucket")();
  }

  let corpusDir = null;
  let typical = {};
  if (corpora.includes("typical")) {
    corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "blot-converter-corpus-"));
    typical = await require("./converter-corpus").build(corpusDir, converters);
  }

  const runs = [];
  for (const name of converters) {
    for (const corpus of corpora) {
      if (corpus === "tests") runs.push({ name, label: name + (sandbox ? "-sandbox" : "") });
      else if (typical[name]) {
        runs.push({ name, label: name + "-typical" + (sandbox ? "-sandbox" : ""), fixtures: typical[name] });
      }
    }
  }

  const results = [];

  for (const { name, label, fixtures } of runs) {
    try {
      const result = await benchmarkConverter(name, n, { label, fixtures });
      results.push(result);

      if (result.skipped) {
        console.log(`[converter-bench] ${label}: skipped (${result.reason})`);
      } else {
        const perFixture = Object.entries(result.fixture_p50_ms)
          .filter(() => fixtures)
          .map(([file, ms]) => `${file}=${ms === null ? "-" : ms.toFixed(1)}`)
          .join(" ");
        console.log(
          `[converter-bench] ${label}: p50=${result.timing_ms.p50.toFixed(2)}ms ` +
            `p95=${result.timing_ms.p95.toFixed(2)}ms peak_rss=${result.peak_rss_mb}MB ` +
            `(${result.fixture_count} fixtures, ${result.conversions} conversions` +
            (sandbox ? `, ${result.sandbox_jobs_per_conversion.toFixed(2)} sandbox jobs each` : "") +
            ")" +
            (perFixture ? `\n[converter-bench]   p50 per file: ${perFixture}` : "")
        );
      }
    } catch (err) {
      console.error(`[converter-bench] ${label}: FAILED - ${err.message}`);
      results.push({ name: label, skipped: true, reason: err.message });
    }
  }

  if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
  if (sandbox) sandbox.close();

  const payload = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    git_sha: process.env.GITHUB_SHA || null,
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length },
    pandoc: pandocVersion(),
    sandbox: Boolean(sandbox),
    corpora,
    n,
    converters: results,
  };

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(payload, null, 2));
    console.log(`[converter-bench] wrote ${output}`);
  }

  return payload;
}

if (require.main === module) {
  main()
    .then(() => {
      // Some converters (sharp/libvips, a lingering pandoc handle) can keep
      // the event loop alive after we're done; force a clean exit rather
      // than hang the CI step.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { benchmarkConverter, listConverters, collectFixtures };
