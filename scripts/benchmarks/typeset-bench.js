#!/usr/bin/env node
// Times the typeset build plugin's walk over generated post HTML against
// typeset's own walker (typeset(html, options)), with the options Blot passes
// by default, and checks both give the same HTML.
//
//   NODE_PATH=app node scripts/benchmarks/typeset-bench.js [--kb 10,50,200] [--n 20]
const typeset = require("typeset");
const walk = require("build/plugins/typeset/walk");
const content = require("./mega/content");

const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith("--")) args[a.slice(2)] = all[i + 1];
});
const SIZES = (args.kb || "10,50,200").split(",").map(Number);
const N = Number(args.n || 20);

// What the plugin passes with its default options (plugins/typeset/index.js)
const OPTIONS = { disable: ["ligatures", "hyphenate"], ignore: ["span.math"] };

const random = content.rng("typeset-bench");
const block = content.htmlBlock(random);
// Prose with the things typeset rewrites: quotes, apostrophes, dashes,
// ellipses and acronyms
const prose = (s) =>
  s.replace(/<p>/g, `<p>"It's NASA's '93 plan" -- said the FBI... `);

function time(fn, html) {
  fn(html, OPTIONS); // warm up
  const ms = [];
  for (let i = 0; i < N; i++) {
    const startedAt = performance.now();
    fn(html, OPTIONS);
    ms.push(performance.now() - startedAt);
  }
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)];
}

const rows = [];
for (const kb of SIZES) {
  const html = prose(content.cut(random, block, kb * 1024));
  const same = typeset(html, OPTIONS) === walk(html, OPTIONS);
  const before = time(typeset, html);
  const after = time(walk, html);
  rows.push({
    kb,
    typeset_ms: +before.toFixed(2),
    walk_ms: +after.toFixed(2),
    speedup: +(before / after).toFixed(1),
    same_output: same,
  });
}
console.table(rows);
