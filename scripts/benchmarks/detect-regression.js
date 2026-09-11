#!/usr/bin/env node
"use strict";

// Look for a *sustained* benchmark regression on master and, if found, open a
// GitHub issue (unless one is already open). Meant to run after the master
// result has been appended to history.
//
//   node scripts/benchmarks/detect-regression.js \
//     --history-dir .benchmarks/history --arch amd64 \
//     --consecutive 3 --threshold 15 [--alert] [--dry-run]
//
// A regression is only reported when the last `--consecutive` master commits
// ALL sit outside the noise band for the same metric, measured against a
// baseline built from the commits *before* that window. This rejects
// single-commit runner noise by construction.

const { spawnSync } = require("child_process");

const { loadHistory, computeBaseline } = require("./lib/history");
const { METRIC_BY_KEY, formatValue } = require("./lib/metrics");
const { classify } = require("./lib/stats");
const { fmtDelta } = require("./lib/report");
const { BENCHMARK_DEFAULTS } = require("../../app/blog/benchmarks/util/defaults");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(name);
}

function gh(args, input) {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    input,
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 9) : "unknown";
}

function main() {
  const historyDir = arg("--history-dir", ".benchmarks/history");
  const arch = arg("--arch", "amd64");
  const consecutive = Number(
    arg("--consecutive", BENCHMARK_DEFAULTS.regressionConsecutive)
  );
  const threshold = Number(
    arg("--threshold", BENCHMARK_DEFAULTS.regressionThresholdPercent)
  );
  const sizeThreshold = Number(
    arg("--size-threshold", BENCHMARK_DEFAULTS.sizeThresholdPercent)
  );
  const alert = flag("--alert");
  const dryRun = flag("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY;

  // Records from an older history schema (a prior tracked-metric set, or a
  // workload shape that shifted totals) are excluded so a schema bump resets
  // the "how many samples do we have" count too, not just the baseline math.
  const history = loadHistory(historyDir, arch).filter(
    (r) => r.schema_version === BENCHMARK_DEFAULTS.historySchemaVersion
  );

  if (history.length < BENCHMARK_DEFAULTS.minBaselineSamples + consecutive) {
    console.log(
      `[detect] ${arch}: only ${history.length} samples; need ` +
        `${BENCHMARK_DEFAULTS.minBaselineSamples + consecutive} before alerting. Skipping.`
    );
    return;
  }

  const windowRecords = history.slice(-consecutive);
  const priorRecords = history.slice(0, -consecutive);
  const baseline = computeBaseline(priorRecords, {
    window: BENCHMARK_DEFAULTS.baselineWindow,
  });

  const offenders = [];

  for (const key of Object.keys(METRIC_BY_KEY)) {
    const metric = METRIC_BY_KEY[key];
    const base = baseline.metrics[key];
    if (!base || !Number.isFinite(base.median)) continue;

    const band = metric.deterministic ? sizeThreshold : threshold;

    const perCommit = windowRecords.map((rec) => {
      const value = rec.metrics ? rec.metrics[key] : null;
      return { rec, value, ...classify(value, base.median, { thresholdPercent: band, mad: base.mad }) };
    });

    const allRegressed = perCommit.every((c) => c.status === "regression");
    if (allRegressed) {
      const latest = perCommit[perCommit.length - 1];
      offenders.push({
        key,
        label: metric.label,
        unit: metric.unit,
        baseline: base.median,
        current: latest.value,
        deltaPercent: latest.deltaPercent,
        perCommit,
      });
    }
  }

  if (!offenders.length) {
    console.log(`[detect] ${arch}: no sustained regression across last ${consecutive} commits.`);
    return;
  }

  const summary = offenders
    .map((o) => `${o.label} ${fmtDelta(o.deltaPercent)}`)
    .join(", ");
  console.log(`[detect] ${arch}: sustained regression — ${summary}`);

  const title = `Benchmark regression on master (${arch}): ${summary}`;

  const firstBad = windowRecords[0];
  const lastGood = priorRecords[priorRecords.length - 1];

  const bodyLines = [
    `A benchmark regression has held for the last **${consecutive}** master commits on \`${arch}\`.`,
    "",
    `Baseline: median of ${baseline.sample_count} commits ` +
      `(\`${shortSha(baseline.first_sha)}\` … \`${shortSha(baseline.last_sha)}\`).`,
    "",
    "| Metric | Baseline | Latest | Δ |",
    "|---|--:|--:|--:|",
    ...offenders.map(
      (o) =>
        `| ${o.label} | ${formatValue(o.baseline, o.unit)} | ` +
        `${formatValue(o.current, o.unit)} | ${fmtDelta(o.deltaPercent)} |`
    ),
    "",
    "#### Commits in the regression window",
    "",
    ...windowRecords.map((rec) => {
      const url = rec.run_url ? ` — [run](${rec.run_url})` : "";
      return `- \`${shortSha(rec.git_sha)}\` (${rec.timestamp})${url}`;
    }),
    "",
    lastGood
      ? `Last commit before the window: \`${shortSha(lastGood.git_sha)}\`. ` +
        `Suspect range: \`${shortSha(lastGood.git_sha)}..${shortSha(firstBad.git_sha)}\`.`
      : "",
    "",
    "<sub>Filed automatically by `.github/workflows/benchmarks.yml`. " +
      "Close once addressed or acknowledged; it will not reopen unless a new " +
      "regression crosses the threshold after recovery.</sub>",
  ].filter((line) => line !== undefined);

  const body = bodyLines.join("\n");

  if (!alert || dryRun || !repo) {
    console.log(
      `[detect] ${arch}: not filing an issue ` +
        `(alert=${alert} dryRun=${dryRun} repo=${!!repo}). Proposed issue:\n\n${title}\n\n${body}`
    );
    return;
  }

  const open = JSON.parse(
    gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      "benchmark-regression",
      "--state",
      "open",
      "--json",
      "number,title",
    ]) || "[]"
  );

  if (open.length) {
    console.log(
      `[detect] ${arch}: issue #${open[0].number} already open — leaving a note instead.`
    );
    gh([
      "issue",
      "comment",
      String(open[0].number),
      "--repo",
      repo,
      "--body",
      `Still regressed on \`${arch}\` as of \`${shortSha(firstBad.git_sha)}\`: ${summary}.`,
    ]);
    return;
  }

  ensureLabel(repo);

  const out = gh(
    [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      "-",
      "--label",
      "benchmark-regression",
    ],
    body
  );
  console.log(`[detect] filed ${out.trim()}`);
}

function ensureLabel(repo) {
  try {
    gh([
      "label",
      "create",
      "benchmark-regression",
      "--repo",
      repo,
      "--color",
      "B60205",
      "--description",
      "Automated benchmark regression alert",
      "--force",
    ]);
  } catch (err) {
    console.warn(`[detect] could not ensure label: ${err.message}`);
  }
}

main();
