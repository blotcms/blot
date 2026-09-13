#!/usr/bin/env node
"use strict";

/**
 * Per-converter build-time micro-benchmark: times N conversions of a
 * converter's own existing test fixtures using its actual `read(blog, path,
 * callback)` function directly - no full blog/Redis/rebuild machinery, since
 * a converter's `read` only touches the filesystem (via helper/localPath,
 * config.blog_folder_dir) and, for some converters (docx/odt), shells out to
 * pandoc/soffice - it does not need Redis at all.
 *
 * Used by .github/workflows/benchmarks-converters.yml, which only invokes
 * this for converters whose directory actually changed.
 *
 *   node scripts/benchmarks/converter-bench.js --converter markdown --n 300
 *   node scripts/benchmarks/converter-bench.js --converter img --converter docx --output /tmp/result.json
 *
 * Requires NODE_PATH=app (same as the rest of scripts/benchmarks) so
 * `require("helper/...")`, `require("config")`, `require("build/...")`
 * resolve.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");

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

async function benchmarkConverter(name, n) {
  const converterModule = require(`../../app/build/converters/${name}`);
  const fixtures = collectFixtures(name, converterModule);

  if (!fixtures.length) {
    return { name, skipped: true, reason: "no usable fixtures found" };
  }

  const config = require("../../app/config");
  const LocalPath = require("../../app/helper/localPath");

  // A throwaway blog ID so `read(blog, path, callback)` (which resolves
  // paths via helper/localPath + config.blog_folder_dir) has somewhere real
  // to read from, without needing Blog.create/Redis.
  const blogID = `converter-bench-${name}`;
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
  const blogDir = LocalPath(blogID, "/");

  fs.mkdirSync(blogDir, { recursive: true });

  // Copy every fixture into the fake blog folder, preserving basename, so
  // read() finds them at a normal-looking blog-relative path.
  const fixtureTasks = fixtures.map((sourcePath, i) => {
    const targetName = `fixture-${i}${path.extname(sourcePath)}`;
    const targetPath = path.join(blogDir, targetName);
    fs.copyFileSync(sourcePath, targetPath);
    return `/${targetName}`;
  });

  const durationsMs = [];
  let errorCount = 0;
  let lastErrorMessage = null;
  let peakRssMb = 0;

  for (let i = 0; i < n; i++) {
    const blogPath = fixtureTasks[i % fixtureTasks.length];

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

  fs.rmSync(blogDir, { recursive: true, force: true });

  if (!durationsMs.length) {
    return {
      name,
      skipped: true,
      reason: `all ${n} conversion(s) errored - last error: ${lastErrorMessage}`,
      error_count: errorCount,
    };
  }

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = durationsMs.reduce((a, b) => a + b, 0);

  return {
    name,
    skipped: false,
    fixture_count: fixtures.length,
    conversions: n,
    error_count: errorCount,
    timing_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      mean: sum / durationsMs.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    },
    peak_rss_mb: Math.round(peakRssMb),
  };
}

async function main() {
  let converters = argAll("--converter");
  const n = Number(arg("--n", 300));
  const output = arg("--output");

  if (!converters.length) {
    converters = listConverters();
  }

  console.log(`[converter-bench] benchmarking: ${converters.join(", ")} (n=${n})`);

  const results = [];

  for (const name of converters) {
    try {
      const result = await benchmarkConverter(name, n);
      results.push(result);

      if (result.skipped) {
        console.log(`[converter-bench] ${name}: skipped (${result.reason})`);
      } else {
        console.log(
          `[converter-bench] ${name}: p50=${result.timing_ms.p50.toFixed(2)}ms ` +
            `p95=${result.timing_ms.p95.toFixed(2)}ms peak_rss=${result.peak_rss_mb}MB ` +
            `(${result.fixture_count} fixtures, ${result.conversions} conversions)`
        );
      }
    } catch (err) {
      console.error(`[converter-bench] ${name}: FAILED - ${err.message}`);
      results.push({ name, skipped: true, reason: err.message });
    }
  }

  const payload = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    git_sha: process.env.GITHUB_SHA || null,
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length },
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
