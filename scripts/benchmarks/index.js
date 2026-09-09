#!/usr/bin/env node
"use strict";

// Runs the benchmark spec (app/blog/benchmarks/benchmarks.js) once and writes a
// single benchmark-result JSON. It does NOT compare against a baseline or gate
// anything - that is done afterwards, outside the container, by:
//
//   scripts/benchmarks/aggregate.js        merge N runs into one result
//   scripts/benchmarks/pr-comment.js       post the PR comparison comment
//   scripts/benchmarks/detect-regression.js open an issue on sustained master drift
//
// See scripts/benchmarks/README.md for the full picture.

var Jasmine = require("jasmine");
var colors = require("colors");
var fs = require("fs-extra");
var path = require("path");
var seedrandom = require("seedrandom");
var clfdate = require("helper/clfdate");

var { BENCHMARK_DEFAULTS } = require("blog/benchmarks/util/defaults");

var args = parseArgs(process.argv.slice(2));
var client = require("models/client");
var registerGlobalTest = require("../tests/register-global-test");

var jasmine = new Jasmine();

var jasmineConfig = {
  spec_dir: "",
  spec_files: ["**/benchmarks/benchmarks.js", "!**/node_modules/**"],
  helpers: [],
  stopSpecOnExpectationFailure: true,
  random: false,
};

if (args.path) {
  console.log(clfdate(), "Running benchmarks in", colors.cyan(args.path));

  if (args.path.endsWith(".js")) {
    jasmineConfig.spec_files = [args.path];
  } else {
    jasmineConfig.spec_dir = args.path;
  }
}

var benchmarkConfig = {
  sites: args.sites,
  files: args.files,
  seed: args.seed,
  renderConcurrency: args.renderConcurrency,
  writeConcurrency: args.writeConcurrency,
  cpuSampleIntervalMs: args.cpuSampleIntervalMs,
  requestsPerPage: args.requestsPerPage,
};

global.__BLOT_BENCHMARK_CONFIG = benchmarkConfig;

seedrandom(benchmarkConfig.seed, { global: true });
jasmine.seed(benchmarkConfig.seed);
jasmine.loadConfig(jasmineConfig);

registerGlobalTest();

console.log(clfdate(), "Benchmark config:", benchmarkConfig);

jasmine.addReporter({
  jasmineDone: function (result) {
    var benchmarkResult = global.__BLOT_BENCHMARK_RESULT || null;
    var exitCode = result.overallStatus === "passed" ? 0 : 1;

    if (result.overallStatus === "passed" && !benchmarkResult) {
      console.error(
        "[benchmark] Missing benchmark result payload from spec run"
      );
      exitCode = 1;
    }

    if (benchmarkResult && args.output) {
      fs.ensureDirSync(path.dirname(args.output));
      fs.writeJsonSync(args.output, benchmarkResult, { spaces: 2 });
      console.log(
        clfdate(),
        "Wrote benchmark result",
        colors.cyan(args.output)
      );
    }

    process.exitCode = exitCode;

    setImmediate(function () {
      process.exit(process.exitCode);
    });
  },
});

(async function ensureEmptyDatabase() {
  let hasKeys = false;

  for await (const batch of client.scanIterator({ MATCH: "*", COUNT: 1 })) {
    if (batch.length > 0) {
      hasKeys = true;
      break;
    }
  }

  if (hasKeys) {
    throw new Error("Database is not empty: keys found");
  }

  jasmine.execute();
})().catch(function (err) {
  throw err;
});

function parseArgs(argv) {
  var parsed = {
    sites: BENCHMARK_DEFAULTS.sites,
    files: BENCHMARK_DEFAULTS.files,
    seed: BENCHMARK_DEFAULTS.seed,
    renderConcurrency: BENCHMARK_DEFAULTS.renderConcurrency,
    writeConcurrency: BENCHMARK_DEFAULTS.writeConcurrency,
    cpuSampleIntervalMs: BENCHMARK_DEFAULTS.cpuSampleIntervalMs,
    requestsPerPage: BENCHMARK_DEFAULTS.requestsPerPage,
    output: null,
    path: null,
    ci: false,
  };

  var positional = [];

  var numericFlags = {
    "--sites": "sites",
    "--files": "files",
    "--render-concurrency": "renderConcurrency",
    "--write-concurrency": "writeConcurrency",
    "--cpu-sample-interval-ms": "cpuSampleIntervalMs",
    "--requests-per-page": "requestsPerPage",
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    var next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--ci") {
      parsed.ci = true;
      continue;
    }

    if (arg === "--seed" && next) {
      parsed.seed = String(next);
      i += 1;
      continue;
    }

    if (arg === "--output" && next) {
      parsed.output = next;
      i += 1;
      continue;
    }

    if (arg === "--path" && next) {
      parsed.path = next;
      i += 1;
      continue;
    }

    if (numericFlags[arg] && next) {
      parsed[numericFlags[arg]] = Number(next);
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error("Unknown argument: " + arg);
    }

    positional.push(arg);
  }

  if (!parsed.path && positional.length) {
    parsed.path = positional[0];
  }

  if (parsed.output) {
    parsed.output = path.resolve(parsed.output);
  }

  ensurePositiveInt(parsed.sites, "--sites");
  ensurePositiveInt(parsed.files, "--files");
  ensurePositiveInt(parsed.renderConcurrency, "--render-concurrency");
  ensurePositiveInt(parsed.writeConcurrency, "--write-concurrency");
  ensurePositiveInt(parsed.cpuSampleIntervalMs, "--cpu-sample-interval-ms");
  ensurePositiveInt(parsed.requestsPerPage, "--requests-per-page");

  return parsed;
}

function ensurePositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(name + " must be a positive integer");
  }
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/benchmarks [options]",
      "",
      "Options:",
      "  --sites <n>                    Number of benchmark sites (default: " +
        BENCHMARK_DEFAULTS.sites +
        ")",
      "  --files <n>                    Total generated files (default: " +
        BENCHMARK_DEFAULTS.files +
        ")",
      "  --seed <value>                 Deterministic seed (default: " +
        BENCHMARK_DEFAULTS.seed +
        ")",
      "  --render-concurrency <n>       Sitemap render concurrency (default: " +
        BENCHMARK_DEFAULTS.renderConcurrency +
        ")",
      "  --write-concurrency <n>        Workload write concurrency (default: " +
        BENCHMARK_DEFAULTS.writeConcurrency +
        ")",
      "  --requests-per-page <n>        Requests per sitemap URL (default: " +
        BENCHMARK_DEFAULTS.requestsPerPage +
        ")",
      "  --cpu-sample-interval-ms <ms>  CPU/memory sampling interval (default: " +
        BENCHMARK_DEFAULTS.cpuSampleIntervalMs +
        ")",
      "  --output <path>                Write JSON benchmark result to path",
      "  --ci                           Non-interactive mode",
      "  --path <path>                  Limit benchmark discovery to path",
      "  --help                         Show this help message",
      "",
    ].join("\n")
  );
}
