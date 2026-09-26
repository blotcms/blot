#!/usr/bin/env node
// Smoke test for the viewer: starts it, loads the page in Chrome, checks the
// case list is populated, a case opens with images, and nothing logs errors.
//   node app/helper/pane/qa/smoke.js
const { createServer } = require("./server");
const { loadCases } = require("./lib/cases");
const { launch } = require("./lib/render");

async function main() {
  const app = createServer();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const problems = [];
  try {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    // the keys below switch view modes quickly, and the viewer cancels the live HTML
    // iframe's request when it leaves that mode: an abort is not a failure
    page.on("requestfailed", (r) => !/ERR_ABORTED/.test(r.failure()?.errorText || "") && problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
    await page.goto(url, { waitUntil: "load" }); // not networkidle: the SSE stream never idles
    await page.waitForSelector("#case-list button");

    const expected = loadCases().length;
    const listed = await page.$$eval("#case-list button", (b) => b.length);
    if (listed !== expected) problems.push(`expected ${expected} cases in the list, found ${listed}`);

    // open the first case that has a render, if any
    const withRender = await page.evaluate(() => fetch("/api/cases").then((r) => r.json()).then((d) => (d.cases.find((c) => c.status !== "missing") || {}).id));
    if (withRender) {
      await page.click(`#case-list button[data-id="${withRender}"]`);
      await page.waitForSelector(".stage img", { timeout: 10000 });
      const loaded = await page.$$eval(".stage img", (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
      if (!loaded) problems.push("images did not load");
      for (const key of ["2", "3", "4", "5", "1"]) await page.keyboard.press(key);
    }
  } finally {
    await browser.close();
    await app.close();
    server.close();
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("viewer smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
