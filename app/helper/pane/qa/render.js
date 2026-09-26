#!/usr/bin/env node
// Renders cases to app/helper/pane/rendered/<os>/. Usage:
//   node app/helper/pane/qa/render.js [--case ID] [--os X] [--theme X] [--view X]
// Only renders cases for which an adapter or fixture exists. Fonts come from
// this machine, so render each OS's cases on that OS (the pane-qa workflow
// does; pass --os to restrict locally).

const { loadCases } = require("./lib/cases");
const { renderCases } = require("./lib/render");
const { parseArgs, selectCases } = require("./lib/args");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = selectCases(loadCases(), args);
  if (!cases.length) {
    console.error("No cases match.");
    process.exit(1);
  }
  const { done, failed } = await renderCases(cases, (line) => console.log(line));
  console.log(`${done.length}/${cases.length} cases rendered, ${failed.length} failed`);
  if (failed.length) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
