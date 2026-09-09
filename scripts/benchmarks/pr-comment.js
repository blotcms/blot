#!/usr/bin/env node
"use strict";

// Post (or update) the single sticky benchmark comment on a pull request.
//
//   # while the run is in flight (shows a loading marker, keeps the old numbers)
//   node scripts/benchmarks/pr-comment.js --pr 1489 --arch amd64 \
//     --status running --sha "$HEAD_SHA"
//
//   # when the run finishes
//   node scripts/benchmarks/pr-comment.js --pr 1489 --arch amd64 \
//     --status done --sha "$HEAD_SHA" \
//     --result .benchmarks/result-amd64.json --history-dir .benchmarks/history
//
//   # if the run failed
//   node scripts/benchmarks/pr-comment.js --pr 1489 --arch amd64 \
//     --status failed --sha "$HEAD_SHA"
//
// Report-only: never fails CI. Requires the `gh` CLI with GH_TOKEN set and
// GITHUB_REPOSITORY in the environment (both provided by GitHub Actions).

const fs = require("fs");
const { spawnSync } = require("child_process");

const { compareToBaseline, markdownTable, hasRegression } = require("./lib/report");
const { loadHistory, computeBaseline } = require("./lib/history");
const { BENCHMARK_DEFAULTS } = require("../../app/blog/benchmarks/util/defaults");

const RESULTS_START = "<!-- bench:results:start -->";
const RESULTS_END = "<!-- bench:results:end -->";
const SHA_RE = /<!--\s*bench:sha:([0-9a-f]{7,40})\s*-->/i;
const LOADING = "⏳"; // hourglass

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[pr-comment] could not parse ${file}: ${err.message}`);
    return null;
  }
}

function gh(args, input) {
  const res = spawnSync("gh", args, { encoding: "utf8", input, env: process.env });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}

// `abc1234` linked to the commit when we have enough context, plain code otherwise.
function commitRef(sha) {
  const s = short(sha);
  if (!s) return null;
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && /^[0-9a-f]{7,40}$/i.test(sha)
    ? `[\`${s}\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${sha})`
    : `\`${s}\``;
}

// Returns the fenced results block (fences included) so it round-trips through
// repeated running/failed updates without losing the fences.
function extractResultsBlock(body) {
  if (!body) return "";
  const s = body.indexOf(RESULTS_START);
  const e = body.indexOf(RESULTS_END);
  if (s === -1 || e === -1 || e < s) return "";
  return body.slice(s, e + RESULTS_END.length).trim();
}

function extractSha(body) {
  const m = body && body.match(SHA_RE);
  return m ? m[1] : null;
}

// The fenced results block: the table plus its provenance footer. `sha` is the
// commit these numbers were produced from; `prevSha` the one before it.
function resultsBlock({ result, baseline, sha, prevSha }) {
  const rows = compareToBaseline(result, baseline);
  const cfg = result.config || {};
  const url = runUrl();

  const footer =
    "<sub>" +
    [
      `seed \`${cfg.seed}\``,
      `${cfg.sites} sites`,
      `${cfg.files} files`,
      `${result.iterations || 1} iteration(s)`,
      baseline && baseline.sample_count
        ? `baseline: median of ${baseline.sample_count}`
        : "baseline: none",
      commitRef(sha) ? `commit ${commitRef(sha)}` : null,
      prevSha && short(prevSha) !== short(sha)
        ? `previous ${commitRef(prevSha)}`
        : null,
      url ? `[run](${url})` : null,
    ]
      .filter(Boolean)
      .join(" · ") +
    "</sub>";

  return [RESULTS_START, "", markdownTable(rows), "", footer, RESULTS_END].join(
    "\n"
  );
}

function callout({ result, baseline }) {
  const rows = compareToBaseline(result, baseline);
  if (!baseline || !baseline.sample_count) {
    return (
      "> No master baseline yet — showing this run's raw numbers. " +
      "Comparisons appear once master has accumulated enough samples."
    );
  }
  if (baseline.sample_count < BENCHMARK_DEFAULTS.minBaselineSamples) {
    return (
      `> Baseline still maturing (${baseline.sample_count}/${BENCHMARK_DEFAULTS.minBaselineSamples} samples). ` +
      "Deltas shown for information only."
    );
  }
  if (hasRegression(rows)) {
    return (
      "> One or more metrics moved outside the noise band. GitHub-hosted " +
      "runners are noisy — treat this as a prompt to look, **not** a merge blocker."
    );
  }
  return "> No metric moved outside the noise band.";
}

function doneBody({ arch, result, baseline, sha, prevSha, marker }) {
  return [
    `### Benchmark — \`${arch}\``,
    "",
    callout({ result, baseline }),
    "",
    resultsBlock({ result, baseline, sha, prevSha }),
    "",
    `<!-- bench:sha:${short(sha) || "none"} -->`,
    marker,
  ].join("\n");
}

// `sha` is the commit now being benchmarked; `prevBlock`/`prevSha` are the
// preserved results (if any) from the last completed run.
function runningBody({ arch, sha, prevBlock, prevSha, marker }) {
  const lines = [`### Benchmark — \`${arch}\` ${LOADING}`, ""];

  if (prevBlock) {
    lines.push(
      `> ${LOADING} Running on ${commitRef(sha) || "the latest commit"}. ` +
        `Numbers below are from ${commitRef(prevSha) || "the previous run"}.`,
      "",
      prevBlock,
      "",
      `<!-- bench:sha:${short(prevSha) || "none"} -->`
    );
  } else {
    lines.push(
      `> ${LOADING} Running on ${commitRef(sha) || "the latest commit"}. ` +
        "Results will appear when the run finishes.",
      ""
    );
  }

  lines.push(marker);
  return lines.join("\n");
}

function failedBody({ arch, sha, prevBlock, prevSha, marker }) {
  const url = runUrl();
  const lines = [`### Benchmark — \`${arch}\` — run failed`, ""];

  lines.push(
    `> The benchmark run for ${commitRef(sha) || "the latest commit"} failed` +
      (url ? ` — see the [run](${url})` : "") +
      "." +
      (prevBlock
        ? ` Numbers below are from ${commitRef(prevSha) || "the previous run"}.`
        : "")
  );

  if (prevBlock) {
    lines.push("", prevBlock, "", `<!-- bench:sha:${short(prevSha) || "none"} -->`);
  }

  lines.push(marker);
  return lines.join("\n");
}

function upsert(repo, pr, current, body) {
  // Send as a JSON request body on stdin so the markdown is escaped by
  // JSON.stringify and never touched by gh's field parsing.
  const payload = JSON.stringify({ body });

  if (current) {
    gh(
      ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${current.id}`, "--input", "-"],
      payload
    );
    console.log(`[pr-comment] updated comment ${current.id}`);
  } else {
    gh(
      ["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"],
      payload
    );
    console.log("[pr-comment] created comment");
  }
}

function main() {
  const pr = arg("--pr");
  const arch = arg("--arch", "amd64");
  const status = arg("--status", "done");
  const sha = arg("--sha");
  const resultFile = arg("--result");
  const baselineFile = arg("--baseline");
  const historyDir = arg("--history-dir");
  const repo = process.env.GITHUB_REPOSITORY;

  if (!pr || !repo) {
    console.error("[pr-comment] need --pr and $GITHUB_REPOSITORY; skipping");
    return;
  }

  const marker = `<!-- blot-benchmark-comment:${arch} -->`;

  try {
    // We need the current comment body up front to preserve the last results
    // and read the previously benchmarked sha.
    const existing = JSON.parse(
      gh([
        "api",
        `repos/${repo}/issues/${pr}/comments`,
        "--paginate",
        "--jq",
        "[.[] | {id, body}]",
      ])
    );
    const current = existing.find((c) => (c.body || "").includes(marker));
    const prevBlock = extractResultsBlock(current && current.body);
    const prevSha = extractSha(current && current.body);

    let body;

    if (status === "running") {
      body = runningBody({ arch, sha, prevBlock, prevSha, marker });
    } else if (status === "failed") {
      body = failedBody({ arch, sha, prevBlock, prevSha, marker });
    } else {
      const result = readJson(resultFile);
      if (!result) {
        console.error(`[pr-comment] no usable result at ${resultFile}; skipping`);
        return;
      }
      let baseline = readJson(baselineFile);
      if (!baseline && historyDir) {
        const history = loadHistory(historyDir, arch);
        baseline = history.length ? computeBaseline(history) : null;
      }
      body = doneBody({
        arch,
        result,
        baseline,
        sha: sha || result.git_sha,
        prevSha,
        marker,
      });
    }

    upsert(repo, pr, current, body);
  } catch (err) {
    // Never fail the build over a comment.
    console.warn(`[pr-comment] ${err.message}`);
  }
}

if (require.main === module) main();

module.exports = {
  doneBody,
  runningBody,
  failedBody,
  extractResultsBlock,
  extractSha,
};
