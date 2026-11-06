#!/usr/bin/env node
// Compares the mega benchmark's base and head runs (base-*.json, head-*.json
// from run.js) and writes the sticky PR comment, or the markdown alone.
//
//   node scripts/benchmarks/mega/compare.js --dir .benchmarks/mega \
//     --base-sha <sha> --head-sha <sha> [--markdown out.md] [--pr 123]
//   node scripts/benchmarks/mega/compare.js --pr 123 --status running|failed
//
// Report-only: it never fails the job. Posting needs gh with GH_TOKEN and
// GITHUB_REPOSITORY, which Actions provides.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MARKER = "<!-- mega-benchmark -->";

// Every metric is lower-is-better
const METRICS = [
  ["Cold render", "cold_catalog_ms", "catalog: first render of its 5 pages"],
  ["Cold render", "cold_catalog_block_ms", "catalog: longest event loop block"],
  ["Cold render", "cold_heavy_ms", "heavy: first render of its 4 pages"],
  ["Cold render", "cold_heavy_block_ms", "heavy: longest event loop block"],
  ["Warm render", "warm_catalog_ms", "catalog: 5 pages, median of 5 passes"],
  ["Warm render", "warm_catalog_block_ms", "catalog: longest event loop block"],
  ["Warm render", "warm_heavy_ms", "heavy: 4 pages, median of 5 passes"],
  ["Warm render", "warm_heavy_block_ms", "heavy: longest event loop block"],
  ["After a cacheID bump", "bump_catalog_ms", "catalog: 5 pages"],
  [
    "After a cacheID bump",
    "bump_catalog_block_ms",
    "catalog: longest event loop block",
  ],
  ["After a cacheID bump", "bump_heavy_ms", "heavy: 4 pages"],
  [
    "After a cacheID bump",
    "bump_heavy_block_ms",
    "heavy: longest event loop block",
  ],
  ["Template previews", "preview_catalog_p50_ms", "catalog: median request"],
  ["Template previews", "preview_catalog_max_ms", "catalog: slowest request"],
  [
    "Template previews",
    "preview_catalog_block_ms",
    "catalog: longest event loop block",
  ],
  ["Template previews", "preview_heavy_p50_ms", "heavy: median request"],
  ["Template previews", "preview_heavy_max_ms", "heavy: slowest request"],
  ["Other blogs", "victim_solo_p95_ms", "small sites alone: p95"],
  [
    "Other blogs",
    "victim_busy_p50_ms",
    "small sites while mega sites resync: p50",
  ],
  [
    "Other blogs",
    "victim_busy_p95_ms",
    "small sites while mega sites resync: p95",
  ],
  [
    "Other blogs",
    "victim_busy_max_ms",
    "small sites while mega sites resync: max",
  ],
  ["Other blogs", "busy_block_ms", "longest event loop block meanwhile"],
  ["Memory", "heap_peak_mb", "peak heap above baseline (MB)"],
  ["Memory", "heap_retained_mb", "heap kept after GC (MB)"],
  ["Render caches", "cache_oversize_fills", "fills too big to store"],
  ["Render caches", "cache_uncached_fills", "fills not stored"],
  ["Render caches", "cache_clone_ms", "time copying cached values (ms)"],
  ["Render caches", "cache_fill_max_ms", "slowest fill (ms)"],
];

// Flag a change this much worse whose ranges don't overlap
const FLAG_PERCENT = 15;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function load(dir, side) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(side + "-") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return "n/a";
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function row(label, base, head) {
  if (!base.length && !head.length) return null;
  const b = base.length ? median(base) : null;
  const h = head.length ? median(head) : null;
  let delta = "";
  let flag = "";

  if (b !== null && h !== null) {
    if (b === 0 && h === 0) delta = "0%";
    else if (b === 0) delta = "new";
    else delta = `${h >= b ? "+" : ""}${Math.round(((h - b) / b) * 100)}%`;

    const apart = Math.min(...head) > Math.max(...base);
    const better = Math.max(...head) < Math.min(...base);
    if (apart && b > 0 && ((h - b) / b) * 100 >= FLAG_PERCENT)
      flag = " (worse)";
    if (better && b > 0 && ((b - h) / b) * 100 >= FLAG_PERCENT)
      flag = " (better)";
  }

  const range = (values) =>
    values.length > 1
      ? ` <sub>${fmt(Math.min(...values))}–${fmt(Math.max(...values))}</sub>`
      : "";

  return `| ${label} | ${fmt(b)}${range(base)} | ${fmt(h)}${range(head)} | ${delta}${flag} |`;
}

function table(baseRuns, headRuns) {
  const lines = [];
  let group = null;

  for (const [section, key, label] of METRICS) {
    const pick = (runs) =>
      runs.map((r) => r.metrics[key]).filter((v) => typeof v === "number");
    const line = row(label, pick(baseRuns), pick(headRuns));
    if (!line) continue;

    if (section !== group) {
      group = section;
      lines.push(`| **${section}** | | | |`);
    }
    lines.push(line);
  }

  return ["| | base | head | change |", "|---|---:|---:|---:|", ...lines].join(
    "\n"
  );
}

function short(sha) {
  return sha ? sha.slice(0, 7) : "?";
}

function doneBody({ baseRuns, headRuns, baseSha, headSha, runUrl }) {
  const shape = (headRuns[0] || baseRuns[0] || {}).shape || {};
  const summary = (name) =>
    shape[name]
      ? `${shape[name].entries} entries, ${shape[name].htmlMB} MB of HTML, ${shape[name].previews} templates`
      : "?";

  return [
    MARKER,
    "### Mega-site benchmark",
    "",
    `\`${short(headSha)}\` (head) against \`${short(baseSha)}\` (base), ` +
      `${headRuns.length} runs each, alternating in one job. ` +
      "Milliseconds unless noted, lower is better; medians, with the range underneath.",
    `"worse" / "better": at least ${FLAG_PERCENT}% worse / better with no overlap between the runs.`,
    "",
    table(baseRuns, headRuns),
    "",
    `<sub>catalog: ${summary("catalog")}. heavy: ${summary("heavy")}. ` +
      "Shapes in `scripts/benchmarks/mega/profile.js`." +
      (runUrl ? ` [Run](${runUrl}).` : "") +
      "</sub>",
  ].join("\n");
}

function statusBody(status, { headSha, runUrl }) {
  const text =
    status === "running"
      ? `Running against \`${short(headSha)}\`…`
      : `The run against \`${short(headSha)}\` failed.`;
  return [
    MARKER,
    "### Mega-site benchmark",
    "",
    text + (runUrl ? ` [Run](${runUrl}).` : ""),
  ].join("\n");
}

function gh(args, input) {
  const result = spawnSync("gh", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "gh failed");
  return result.stdout;
}

function upsert(pr, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const comments = JSON.parse(
    gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments`])
  ).flat();
  const current = comments.find((c) => (c.body || "").includes(MARKER));
  const payload = JSON.stringify({ body });

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
  } else {
    gh(
      [
        "api",
        "--method",
        "POST",
        `repos/${repo}/issues/${pr}/comments`,
        "--input",
        "-",
      ],
      payload
    );
  }
}

function main() {
  const pr = arg("--pr");
  const status = arg("--status", "done");
  const headSha = arg("--head-sha");
  const baseSha = arg("--base-sha");
  const runUrl = arg("--run-url");
  let body;

  if (status === "done") {
    const dir = arg("--dir", ".benchmarks/mega");
    const baseRuns = load(dir, "base");
    const headRuns = load(dir, "head");
    body =
      baseRuns.length || headRuns.length
        ? doneBody({ baseRuns, headRuns, baseSha, headSha, runUrl })
        : statusBody("failed", { headSha, runUrl });
  } else {
    body = statusBody(status, { headSha, runUrl });
  }

  const out = arg("--markdown");
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body + "\n");
  }
  console.log(body);

  if (pr) {
    try {
      upsert(pr, body);
    } catch (err) {
      console.error("[mega] could not post the comment:", err.message);
    }
  }
}

main();
