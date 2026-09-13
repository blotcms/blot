#!/usr/bin/env node
"use strict";

/**
 * Host-side orchestrator for the "build once, cache, restore" corpus.
 *
 * Builds a large, production-shaped corpus (default: 1000 sites, ~160k
 * posts, skewed distribution - see scripts/benchmarks/spec/util/workload.js)
 * once inside Docker + a throwaway Redis, then snapshots it into three
 * cache-able artifacts under --out-dir (default .benchmarks/corpus/):
 *
 *   - redis-dump.rdb   Redis SAVE dump: every entry/tag/index key
 *   - blogs.tar.gz     data/blogs/ (raw source + hard-linked media - small,
 *                       see the media-pool trick in workload.js)
 *   - static.tar.gz    data/static/ (derived/build output - the expensive
 *                       part to regenerate)
 *   - manifest.json    which blog IDs/handles make up the corpus, plus each
 *                       site's tags/search keywords/hub path, so
 *                       corpusMode "render" can run against it without
 *                       recomputing the workload
 *
 * Used standalone for local rehearsal (with small --sites/--files overrides)
 * and by .github/workflows/benchmarks-corpus.yml.
 *
 * NOTE: this script has not been exercised end-to-end in this environment
 * (no Docker/Redis available) - see scripts/benchmarks/README.md for what
 * was and wasn't actually run.
 */
const path = require("path");
const fs = require("fs-extra");
const { execFileSync } = require("child_process");
const { BENCHMARK_DEFAULTS } = require("./spec/util/defaults");

const ROOT_DIR = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const parsed = {
    sites: BENCHMARK_DEFAULTS.corpusSites,
    files: BENCHMARK_DEFAULTS.corpusFiles,
    mediaFraction: BENCHMARK_DEFAULTS.corpusMediaFraction,
    seed: BENCHMARK_DEFAULTS.seed,
    outDir: path.join(ROOT_DIR, ".benchmarks/corpus"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--sites" && next) {
      parsed.sites = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--files" && next) {
      parsed.files = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--media-fraction" && next) {
      parsed.mediaFraction = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--seed" && next) {
      parsed.seed = next;
      i += 1;
      continue;
    }
    if (arg === "--out-dir" && next) {
      parsed.outDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/benchmarks/build-corpus.js [options]",
      "",
      "Options:",
      "  --sites <n>            Number of sites (default: " +
        BENCHMARK_DEFAULTS.corpusSites +
        ")",
      "  --files <n>            Total posts across all sites (default: " +
        BENCHMARK_DEFAULTS.corpusFiles +
        ")",
      "  --media-fraction <0-1> Fraction of posts with a hard-linked media file (default: " +
        BENCHMARK_DEFAULTS.corpusMediaFraction +
        ")",
      "  --seed <value>         Deterministic seed (default: " +
        BENCHMARK_DEFAULTS.seed +
        ")",
      "  --out-dir <path>       Where to write the artifacts (default: .benchmarks/corpus)",
      "",
      "Example (small local rehearsal):",
      "  node scripts/benchmarks/build-corpus.js --sites 20 --files 2000",
      "",
    ].join("\n")
  );
}

function run(cmd, args, opts = {}) {
  console.log("+", cmd, args.join(" "));
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function tryRun(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch (err) {
    // best-effort cleanup
  }
}

function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const dataDir = path.join(args.outDir, "data");
  const blogsDir = path.join(dataDir, "blogs");
  const staticDir = path.join(dataDir, "static");

  fs.removeSync(dataDir);
  fs.ensureDirSync(blogsDir);
  fs.ensureDirSync(staticDir);
  fs.ensureDirSync(args.outDir);

  const benchId = `blot-corpus-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const redisContainer = `benchmark-corpus-redis-${benchId}`;
  const benchContainer = `benchmark-corpus-runner-${benchId}`;
  const network = `benchmark-corpus-net-${benchId}`;
  const image = "blot-bench";

  function cleanup() {
    tryRun("docker", ["rm", "-f", benchContainer]);
    tryRun("docker", ["rm", "-f", redisContainer]);
    tryRun("docker", ["network", "rm", network]);
  }

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  cleanup(); // in case a previous run left something behind with a reused id

  run("docker", ["network", "create", network]);
  run("docker", [
    "run",
    "-d",
    "--name",
    redisContainer,
    "--network",
    network,
    "--rm",
    // Pinned to the exact image used everywhere else (benchmarks.yml,
    // benchmarks-render.yml's services.redis.image) - the RDB dump this
    // produces gets loaded into a redis:6 container downstream via
    // `DEBUG RELOAD`, so a floating tag resolving to an incompatible major
    // would break that restore.
    "redis:6",
    "sh",
    "-c",
    "rm -f /data/dump.rdb && redis-server",
  ]);
  run("docker", ["build", "--target", "dev", "-t", image, ROOT_DIR]);

  const benchmarkArgs = [
    "--corpus-mode",
    "build",
    "--distribution",
    "skewed",
    "--sites",
    String(args.sites),
    "--files",
    String(args.files),
    "--media-fraction",
    String(args.mediaFraction),
    "--seed",
    String(args.seed),
    "--corpus-manifest-path",
    "/benchmarks/manifest.json",
  ].join(" ");

  run("docker", [
    "run",
    "--rm",
    "--name",
    benchContainer,
    "--network",
    network,
    "-e",
    `BLOT_REDIS_HOST=${redisContainer}`,
    "-e",
    "BLOT_HOST=localhost",
    "-e",
    "BLOT_PROTOCOL=https",
    // Docker does not inherit arbitrary host env vars into the container -
    // forward GITHUB_SHA explicitly so index.js's manifest writer (which
    // reads process.env.GITHUB_SHA for provenance) doesn't always see null
    // in CI.
    "-e",
    `GITHUB_SHA=${process.env.GITHUB_SHA || ""}`,
    "-v",
    `${path.join(ROOT_DIR, "app")}:/usr/src/app/app`,
    "-v",
    `${path.join(ROOT_DIR, "scripts")}:/usr/src/app/scripts`,
    "-v",
    `${path.join(ROOT_DIR, "config")}:/usr/src/app/config`,
    "-v",
    `${dataDir}:/usr/src/app/data`,
    "-v",
    `${args.outDir}:/benchmarks`,
    image,
    "sh",
    "-lc",
    `node scripts/benchmarks ${benchmarkArgs}`,
  ]);

  // Snapshot Redis: SAVE inside the container, then copy dump.rdb out.
  run("docker", ["exec", redisContainer, "redis-cli", "SAVE"]);
  run("docker", [
    "cp",
    `${redisContainer}:/data/dump.rdb`,
    path.join(args.outDir, "redis-dump.rdb"),
  ]);

  // Tar the two data directories. Hard links within data/blogs (see
  // workload.js's media strategy) are deduplicated by tar automatically.
  run("tar", [
    "-czf",
    path.join(args.outDir, "blogs.tar.gz"),
    "-C",
    dataDir,
    "blogs",
  ]);
  run("tar", [
    "-czf",
    path.join(args.outDir, "static.tar.gz"),
    "-C",
    dataDir,
    "static",
  ]);

  const artifacts = ["redis-dump.rdb", "blogs.tar.gz", "static.tar.gz"].map(
    (name) => {
      const p = path.join(args.outDir, name);
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      return { name, size };
    }
  );

  const totalBytes = artifacts.reduce((sum, a) => sum + a.size, 0);

  console.log("\nCorpus artifacts:");
  for (const artifact of artifacts) {
    console.log(`  ${artifact.name}: ${formatMb(artifact.size)}`);
  }
  console.log(`  total: ${formatMb(totalBytes)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "",
      "**Corpus artifact sizes** (target: low single-digit GB combined - the GitHub Actions cache cap is 10GB per repo, shared with every other cache)",
      "",
      ...artifacts.map((a) => `- \`${a.name}\`: ${formatMb(a.size)}`),
      `- **total**: ${formatMb(totalBytes)}`,
      "",
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
}

main();
