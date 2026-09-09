#!/usr/bin/env node
"use strict";

// Best-effort: make sure .benchmarks/history/history-<arch>.ndjson exists.
// The GitHub Actions cache is the primary store; if it missed (first run,
// eviction after 7 idle days), fall back to the newest `benchmark-history-<arch>`
// artifact from a successful master run of this workflow.
//
//   node scripts/benchmarks/seed-history.js --arch amd64 --history-dir .benchmarks/history
//
// Never fails: if nothing can be recovered, history simply starts fresh.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function gh(args, opts = {}) {
  return spawnSync("gh", args, { encoding: "utf8", env: process.env, ...opts });
}

function main() {
  const arch = arg("--arch", "amd64");
  const historyDir = arg("--history-dir", ".benchmarks/history");
  const workflow = arg("--workflow", "benchmarks.yml");
  const repo = process.env.GITHUB_REPOSITORY;
  const file = path.join(historyDir, `history-${arch}.ndjson`);

  fs.mkdirSync(historyDir, { recursive: true });

  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    console.log(`[seed] ${arch}: cache hit (${lines} records); nothing to do.`);
    return;
  }

  if (!repo || !process.env.GH_TOKEN) {
    console.log(`[seed] ${arch}: no repo/token context; starting fresh.`);
    return;
  }

  try {
    const runs = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/workflows/${workflow}/runs?branch=master&event=push&status=success&per_page=20`,
        "--jq",
        "[.workflow_runs[] | .databaseId // .id]",
      ]).stdout || "[]"
    );

    const artifactName = `benchmark-history-${arch}`;

    for (const runId of runs) {
      const artifactId = (
        gh([
          "api",
          `repos/${repo}/actions/runs/${runId}/artifacts`,
          "--jq",
          `.artifacts[] | select(.name=="${artifactName}") | .id`,
        ]).stdout || ""
      )
        .trim()
        .split("\n")[0];

      if (!artifactId) continue;

      const tmpZip = path.join(historyDir, `_seed-${arch}.zip`);
      const dl = gh(
        ["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`],
        { encoding: "buffer" }
      );

      if (dl.status !== 0 || !dl.stdout || !dl.stdout.length) continue;
      fs.writeFileSync(tmpZip, dl.stdout);

      const unzip = spawnSync("unzip", ["-o", tmpZip, "-d", historyDir], {
        encoding: "utf8",
      });
      fs.rmSync(tmpZip, { force: true });

      if (unzip.status === 0 && fs.existsSync(file)) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
          .length;
        console.log(
          `[seed] ${arch}: recovered ${lines} records from run ${runId}.`
        );
        return;
      }
    }

    console.log(`[seed] ${arch}: no recoverable artifact; starting fresh.`);
  } catch (err) {
    console.warn(`[seed] ${arch}: ${err.message}; starting fresh.`);
  }
}

main();
