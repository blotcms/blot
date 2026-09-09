#!/usr/bin/env node
"use strict";

// Merge several single-run benchmark-result JSON files into one aggregated
// result (median per metric). Runs on the host, after the container has
// produced one JSON per iteration.
//
//   node scripts/benchmarks/aggregate.js --output result.json run-1.json run-2.json run-3.json

const fs = require("fs");
const path = require("path");
const { aggregateResults } = require("./lib/aggregate");

function main() {
  const argv = process.argv.slice(2);
  const inputs = [];
  let output = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" && argv[i + 1]) {
      output = argv[++i];
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: node scripts/benchmarks/aggregate.js --output <file> <result.json>..."
      );
      process.exit(0);
    } else {
      inputs.push(argv[i]);
    }
  }

  if (!inputs.length) {
    console.error("aggregate: no input files given");
    process.exit(1);
  }

  const results = inputs.map((file) =>
    JSON.parse(fs.readFileSync(file, "utf8"))
  );
  const merged = aggregateResults(results);

  const json = JSON.stringify(merged, null, 2);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, json);
    console.log(
      `[aggregate] ${inputs.length} run(s) -> ${output} ` +
        `(build p50 ${round(merged.build.timing_ms.p50)}ms, ` +
        `render p50 ${round(merged.render.timing_ms.p50)}ms)`
    );
  } else {
    process.stdout.write(json + "\n");
  }
}

function round(n) {
  return Number.isFinite(n) ? Math.round(n) : "n/a";
}

main();
