#!/usr/bin/env node
// Backdrop independence: renders each case's window on a black and a white desktop and
// checks it is opaque inside, clear far outside, and transparent at rounded corners
// (see lib/matte.js and DESIGN.md "Backdrop independence"). Also writes cutout.png (the
// window with real alpha, for compositing onto any image) and matte.png to qa/out/<id>/.
//   node app/helper/pane/qa/backdrop.js [--case ID] [--os X] [--theme X] [--view X | --all] [--json]
// Fonts don't matter here, so any OS's cases can be checked on any machine. Exit 1 on failures.

const { loadCases } = require("./lib/cases");
const { parseArgs, selectCases } = require("./lib/args");
const { launch } = require("./lib/render");
const { matte } = require("./lib/matte");

const pad = (t, n, right) => (right ? String(t).padStart(n) : String(t).padEnd(n));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // the default view is what the module renders; other views are hand-written fixtures
  const cases = selectCases(loadCases(), args).filter((c) => args.all || args.view || c.view === "default");
  if (!cases.length) {
    console.error("No cases match.");
    process.exit(2);
  }
  const browser = await launch();
  const results = [];
  try {
    for (const c of cases) {
      try {
        const r = await matte(browser, c, { images: true });
        if (r) results.push(r);
      } catch (err) {
        results.push({ id: c.id, failures: [`error: ${err.message}`] });
      }
    }
  } finally {
    await browser.close();
  }
  if (args.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else {
    console.log(`${pad("case", 16)} ${pad("result", 6)} ${pad("interior", 9, 1)} ${pad("far", 6, 1)} ${pad("shadow", 7, 1)}  extent t/r/b/l (css px)`);
    for (const r of results) {
      const e = r.shadow ? Object.values(r.shadow.extent).join("/") : "";
      console.log(
        `${pad(r.id, 16)} ${pad(r.failures.length ? "FAIL" : "pass", 6)} ${pad(r.interior ? r.interior.minAlpha.toFixed(2) : "-", 9, 1)} ${pad(r.farMaxAlpha === undefined ? "-" : r.farMaxAlpha.toFixed(2), 6, 1)} ${pad(r.shadow ? r.shadow.maxAlpha.toFixed(2) : "-", 7, 1)}  ${e}`
      );
      for (const f of r.failures) console.log(`    ${f}`);
    }
  }
  process.exit(results.some((r) => r.failures.length) ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
