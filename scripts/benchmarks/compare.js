#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const FORMAT_DIFF = path.join(__dirname, "format-diff.js");

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

function runInvoke(cwd, outputRelative) {
  const invokeSh = path.join(cwd, "scripts", "benchmarks", "invoke.sh");
  const r = spawnSync(invokeSh, ["--output", outputRelative], {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (r.status !== 0) {
    throw new Error(`Benchmark failed with exit code ${r.status}`);
  }
  return path.join(cwd, outputRelative);
}

function main() {
  const args = process.argv.slice(2);
  const branch =
    args.length > 0 && !args[0].startsWith("-") ? args[0] : null;

  if (!branch) {
    // No branch: delegate to invoke.sh with any passed args
    const invokeSh = path.join(
      process.cwd(),
      "scripts",
      "benchmarks",
      "invoke.sh"
    );
    const r = spawnSync(invokeSh, args, { stdio: "inherit", shell: false });
    process.exit(r.status == null ? 1 : r.status);
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const worktreeName = "compare-worktree-" + branch.replace(/\//g, "-");
  const worktreePath = path.join(repoRoot, ".benchmarks", worktreeName);
  const currentOutput = path.join(repoRoot, ".benchmarks", "compare-current.json");
  const branchOutput = path.join(worktreePath, ".benchmarks", "compare-branch.json");

  console.log("[compare] Running benchmark on current branch...");
  runInvoke(repoRoot, ".benchmarks/compare-current.json");

  console.log("[compare] Creating worktree for branch:", branch);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(["worktree", "add", worktreePath, branch]);

  try {
    console.log("[compare] Running benchmark on branch:", branch);
    runInvoke(worktreePath, ".benchmarks/compare-branch.json");

    const currentResult = JSON.parse(fs.readFileSync(currentOutput, "utf8"));
    const branchResult = JSON.parse(fs.readFileSync(branchOutput, "utf8"));

    const { printCompareTable } = require(FORMAT_DIFF);
    console.log("\n  ---  current  vs  " + branch + "  ---");
    printCompareTable(currentResult, branchResult);
  } finally {
    console.log("[compare] Removing worktree...");
    git(["worktree", "remove", worktreePath, "--force"]);
  }
}

main();
