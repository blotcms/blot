#!/usr/bin/env node
// Times build/prepare (title, summary, teasers, tags, permalink fields) on
// generated post HTML, the CPU-only step every entry build ends with. Half
// the posts have a <!-- more --> breakpoint and half are teasered
// automatically; all of them use the word "more" somewhere, as prose does.
// Needs nothing running (models/client logs that Redis is down, harmlessly).
//
//   NODE_PATH=app node scripts/benchmarks/prepare-bench.js [--kb 5,20,80] [--n 30]
const Prepare = require("build/prepare");
const content = require("./mega/content");

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith("--")) args[a.slice(2)] = all[i + 1];
});
const SIZES = (args.kb || "5,20,80").split(",").map(Number);
const N = Number(args.n || 30);

const random = content.rng("prepare-bench");
const block = content.htmlBlock(random);

function post(kb, withBreakpoint) {
  const parts = content.cut(random, block, kb * 1024).split("\n");
  parts[0] = "<h1>A title, and more</h1>";
  if (withBreakpoint) parts.splice(Math.floor(parts.length / 3), 0, "<!-- more -->");
  return parts.join("\n");
}

function entry(html) {
  return {
    path: "/Posts/a-title.md",
    name: "a-title.md",
    size: html.length,
    html,
    updated: Date.now(),
    draft: false,
    metadata: {},
  };
}

const rows = [];
for (const kb of SIZES) {
  for (const withBreakpoint of [false, true]) {
    const html = post(kb, withBreakpoint);
    Prepare(entry(html)); // warm up
    const ms = [];
    for (let i = 0; i < N; i++) {
      const startedAt = performance.now();
      Prepare(entry(html));
      ms.push(performance.now() - startedAt);
    }
    ms.sort((a, b) => a - b);
    rows.push({
      kb,
      breakpoint: withBreakpoint,
      p50_ms: +ms[Math.floor(N / 2)].toFixed(2),
    });
  }
}
console.table(rows);
process.exit(0);
