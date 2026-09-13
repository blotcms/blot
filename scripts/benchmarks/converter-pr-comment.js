#!/usr/bin/env node
"use strict";

/**
 * Sticky PR comment + rolling per-converter history for converter-bench.js,
 * loosely mirroring pr-comment.js/update-history.js/detect-regression.js but
 * intentionally simplified: each converter only tracks one metric (p50 wall
 * time per conversion, plus peak RSS for context), so the full multi-metric
 * history/baseline/regression apparatus built for the render benchmark
 * would be overkill here.
 *
 *   # after converter-bench.js has written a result JSON:
 *   node scripts/benchmarks/converter-pr-comment.js \
 *     --pr 1489 --result /tmp/converter-result.json \
 *     --history-dir .benchmarks/converter-history --update-history
 *
 * History is one NDJSON file per converter (history-<name>.ndjson) under
 * --history-dir, one line per master run, same cache-based pattern as the
 * main benchmark history (see .github/workflows/benchmarks-converters.yml).
 *
 * Report-only: never fails CI over a comment/history error.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MARKER = "<!-- blot-converter-benchmark-comment -->";
const DEFAULT_REGRESSION_THRESHOLD_PERCENT = 20;
const BASELINE_WINDOW = 20;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function gh(args, input) {
  const res = spawnSync("gh", args, { encoding: "utf8", input, env: process.env });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return null;
  }
}

function historyFile(historyDir, name) {
  return path.join(historyDir, `history-${name}.ndjson`);
}

function loadHistory(historyDir, name) {
  const file = historyFile(historyDir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
}

function appendHistory(historyDir, name, record) {
  fs.mkdirSync(historyDir, { recursive: true });
  fs.appendFileSync(historyFile(historyDir, name), JSON.stringify(record) + "\n");
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function baselineFor(historyDir, name) {
  const history = loadHistory(historyDir, name).slice(-BASELINE_WINDOW);
  if (!history.length) return null;
  return {
    p50: median(history.map((r) => r.timing_ms.p50)),
    sample_count: history.length,
  };
}

function deltaPercent(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}

function buildTable(converters, historyDir, thresholdPercent) {
  const rows = [
    "| Converter | Fixtures | p50 | p95 | Peak RSS | vs. baseline |",
    "|---|--:|--:|--:|--:|--:|",
  ];

  let anyRegression = false;

  for (const conv of converters) {
    if (conv.skipped) {
      rows.push(`| ${conv.name} | — | — | — | — | skipped (${conv.reason}) |`);
      continue;
    }

    const baseline = historyDir ? baselineFor(historyDir, conv.name) : null;
    const delta = baseline ? deltaPercent(conv.timing_ms.p50, baseline.p50) : null;
    const isRegression = delta !== null && delta > thresholdPercent;
    if (isRegression) anyRegression = true;

    const deltaCell =
      delta === null
        ? baseline
          ? "n/a"
          : "no baseline"
        : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%${isRegression ? " ⚠️" : ""}`;

    rows.push(
      `| ${conv.name} | ${conv.fixture_count} | ${conv.timing_ms.p50.toFixed(2)}ms | ` +
        `${conv.timing_ms.p95.toFixed(2)}ms | ${conv.peak_rss_mb}MB | ${deltaCell} |`
    );
  }

  return { table: rows.join("\n"), anyRegression };
}

function main() {
  const pr = arg("--pr");
  const resultFile = arg("--result");
  const historyDir = arg("--history-dir");
  const sha = arg("--sha");
  const thresholdPercent = Number(
    arg("--threshold", DEFAULT_REGRESSION_THRESHOLD_PERCENT)
  );
  const shouldUpdateHistory = flag("--update-history");
  const repo = process.env.GITHUB_REPOSITORY;

  const result = readJson(resultFile);

  if (!result) {
    console.error(`[converter-pr-comment] no usable result at ${resultFile}`);
    return;
  }

  const { table, anyRegression } = buildTable(
    result.converters,
    historyDir,
    thresholdPercent
  );

  if (shouldUpdateHistory && historyDir) {
    for (const conv of result.converters) {
      if (conv.skipped) continue;
      appendHistory(historyDir, conv.name, {
        timestamp: result.timestamp,
        git_sha: result.git_sha,
        timing_ms: conv.timing_ms,
        peak_rss_mb: conv.peak_rss_mb,
        conversions: conv.conversions,
      });
    }
    console.log(`[converter-pr-comment] appended history to ${historyDir}`);
  }

  const summary = [
    "### Converter benchmark",
    "",
    anyRegression
      ? `> One or more converters regressed beyond the ${thresholdPercent}% band vs. their rolling median.`
      : "> No converter moved outside the noise band.",
    "",
    table,
    "",
    `<sub>seed conversions: ${result.n} · commit \`${(sha || result.git_sha || "unknown").slice(0, 7)}\`</sub>`,
    MARKER,
  ].join("\n");

  if (!pr || !repo) {
    console.log("[converter-pr-comment] no --pr/$GITHUB_REPOSITORY; printing only:\n");
    console.log(summary);
    return;
  }

  try {
    const existing = JSON.parse(
      gh([
        "api",
        `repos/${repo}/issues/${pr}/comments`,
        "--paginate",
        "--jq",
        "[.[] | {id, body}]",
      ])
    );
    const current = existing.find((c) => (c.body || "").includes(MARKER));
    const payload = JSON.stringify({ body: summary });

    if (current) {
      gh(
        [
          "api",
          "--method",
          "PATCH",
          `repos/${repo}/issues/comments/${current.id}`,
          "--input",
          "-",
        ],
        payload
      );
      console.log(`[converter-pr-comment] updated comment ${current.id}`);
    } else {
      gh(["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], payload);
      console.log("[converter-pr-comment] created comment");
    }
  } catch (err) {
    console.warn(`[converter-pr-comment] ${err.message}`);
  }
}

if (require.main === module) main();

module.exports = { buildTable, loadHistory, appendHistory, baselineFor };
