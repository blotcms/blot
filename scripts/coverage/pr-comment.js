#!/usr/bin/env node
"use strict";

// Post (or update) the single sticky code-coverage comment on a pull request.
//
//   node scripts/coverage/pr-comment.js --pr 1789 --sha "$HEAD_SHA" \
//     --status done --summary coverage/coverage-summary.json \
//     --baseline .coverage/history/latest.json \
//     --artifact-url "$ARTIFACT_URL"
//
//   node scripts/coverage/pr-comment.js --pr 1789 --sha "$HEAD_SHA" --status failed
//
// Report-only: never fails CI. Requires the `gh` CLI with GH_TOKEN set and
// GITHUB_REPOSITORY in the environment (both provided by GitHub Actions).

const fs = require("fs");
const { spawnSync } = require("child_process");

const MARKER = "<!-- blot-coverage-comment -->";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[coverage-comment] could not parse ${file}: ${err.message}`);
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

function pct(n) {
  return `${n.toFixed(1)}%`;
}

function delta(current, baselinePct) {
  if (typeof baselinePct !== "number") return "";
  const d = current - baselinePct;
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${d.toFixed(1)}% vs \`master\`)`;
}

function doneBody({ sha, summary, baselinePct, artifactUrl }) {
  const lines = summary.total.lines;
  const url = runUrl();

  const footer =
    "<sub>" +
    [
      `${lines.covered}/${lines.total} lines`,
      `statements ${pct(summary.total.statements.pct)}`,
      `branches ${pct(summary.total.branches.pct)}`,
      `functions ${pct(summary.total.functions.pct)}`,
      commitRef(sha) ? `commit ${commitRef(sha)}` : null,
      artifactUrl ? `[full report](${artifactUrl})` : null,
      url ? `[run](${url})` : null,
    ]
      .filter(Boolean)
      .join(" · ") +
    "</sub>";

  return [
    `### Code coverage: ${pct(lines.pct)}${delta(lines.pct, baselinePct)}`,
    "",
    footer,
    "",
    MARKER,
  ].join("\n");
}

function failedBody({ sha }) {
  const url = runUrl();
  return [
    "### Code coverage — run failed",
    "",
    `> The coverage report for ${commitRef(sha) || "the latest commit"} failed to build` +
      (url ? ` — see the [run](${url})` : "") +
      ".",
    "",
    MARKER,
  ].join("\n");
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
    console.log(`[coverage-comment] updated comment ${current.id}`);
  } else {
    gh(
      ["api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"],
      payload
    );
    console.log("[coverage-comment] created comment");
  }
}

function main() {
  const pr = arg("--pr");
  const sha = arg("--sha");
  const status = arg("--status", "done");
  const summaryFile = arg("--summary");
  const baselineFile = arg("--baseline");
  const artifactUrl = arg("--artifact-url");
  const repo = process.env.GITHUB_REPOSITORY;

  if (!pr || !repo) {
    console.error("[coverage-comment] need --pr and $GITHUB_REPOSITORY; skipping");
    return;
  }

  try {
    // We need the current comment body up front to find the sticky comment
    // (if any) so we PATCH instead of creating a new one each run.
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

    let body;
    if (status === "failed") {
      body = failedBody({ sha });
    } else {
      const summary = readJson(summaryFile);
      if (!summary || !summary.total) {
        console.error(`[coverage-comment] no usable summary at ${summaryFile}; skipping`);
        return;
      }
      const baseline = readJson(baselineFile);
      const baselinePct =
        baseline && typeof baseline.linesPct === "number" ? baseline.linesPct : null;
      body = doneBody({ sha, summary, baselinePct, artifactUrl });
    }

    upsert(repo, pr, current, body);
  } catch (err) {
    // Never fail the build over a comment.
    console.warn(`[coverage-comment] ${err.message}`);
  }
}

if (require.main === module) main();

module.exports = { doneBody, failedBody };
