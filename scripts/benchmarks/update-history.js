#!/usr/bin/env node
"use strict";

// Append a master benchmark result to the rolling history and recompute the
// baseline file. Runs on the host after aggregate.js.
//
//   node scripts/benchmarks/update-history.js \
//     --result .benchmarks/result-amd64.json \
//     --arch amd64 \
//     --history-dir .benchmarks/history

const fs = require("fs");
const path = require("path");

const {
  loadHistory,
  recordFromResult,
  appendRecord,
  computeBaseline,
} = require("./lib/history");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const resultFile = arg("--result");
  const arch = arg("--arch", "amd64");
  const historyDir = arg("--history-dir", ".benchmarks/history");

  if (!resultFile || !fs.existsSync(resultFile)) {
    console.error(`[history] result file not found: ${resultFile}`);
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));

  const runUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const record = recordFromResult(result, { arch, runUrl });

  // Idempotency: don't double-append if the same commit re-runs.
  const history = loadHistory(historyDir, arch);
  if (record.git_sha && history.some((r) => r.git_sha === record.git_sha)) {
    console.log(`[history] ${arch}: ${record.git_sha} already recorded; skipping append.`);
  } else {
    appendRecord(historyDir, arch, record);
    history.push(record);
    console.log(`[history] ${arch}: appended ${record.git_sha} (${history.length} total).`);
  }

  const baseline = computeBaseline(history, { excludeSha: record.git_sha });
  const baselineFile = path.join(historyDir, `baseline-${arch}.json`);
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  console.log(
    `[history] ${arch}: baseline from ${baseline.sample_count} samples -> ${baselineFile}`
  );
}

main();
