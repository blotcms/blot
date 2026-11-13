// Runs axe-core (loaded from cdnjs) on dashboard pages and prints each
// accessibility violation with up to three of the elements it found.
// usage: node axe.js [--slot a|main] [/path,/path,...]
/* global axe */ // loaded into the page by addScriptTag, used in page.evaluate
const puppeteer = require("puppeteer");
const { target, loginURL } = require("./login");

const args = process.argv.slice(2);
const slotIndex = args.indexOf("--slot");
const slot = slotIndex === -1 ? "a" : args.splice(slotIndex, 2)[1];
const AXE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const pages = args[0]
  ? args[0].split(",")
  : [
      "/sites",
      "/sites/account",
      "/sites/support",
      "/sites/local",
      "/sites/local/activity",
      "/sites/local/posts",
      "/sites/local/folder/Home.md",
      "/sites/local/title",
      "/sites/local/domain",
      "/sites/local/settings/writing",
      "/sites/local/settings/images",
      "/sites/local/settings/date",
      "/sites/local/settings/links",
      "/sites/local/settings/redirects",
      "/sites/local/settings/integrations",
      "/sites/local/import",
      "/sites/local/export",
      "/sites/local/delete",
      "/sites/local/template",
      "/sites/local/template/blog",
    ];

(async () => {
  const { host, container } = target(slot);
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(loginURL({ host, container }), { waitUntil: "networkidle2" });
  const counts = {};

  for (const path of pages) {
    let response;
    try {
      // "load", not "networkidle2": pages with a live status stream never go idle
      response = await page.goto(host + path, {
        waitUntil: "load",
        timeout: 60000,
      });
    } catch (e) {
      console.log("could not load", path, e.message);
      continue;
    }
    await page.addScriptTag({ url: AXE });
    const { violations } = await page.evaluate(() =>
      axe.run({ resultTypes: ["violations"] })
    );
    console.log("\n==", path, response.status());

    for (const violation of violations) {
      // Skip the local dev overlay and the template preview's own page
      const nodes = violation.nodes.filter(
        (node) => !/agentation|iframe/.test(node.target.join(" "))
      );
      if (!nodes.length) continue;
      counts[violation.id] = (counts[violation.id] || 0) + nodes.length;
      console.log(
        `  ${violation.id} [${violation.impact}] ${violation.help} (${nodes.length})`
      );
      nodes
        .slice(0, 3)
        .forEach((node) => console.log("    " + node.target.join(" ")));
    }
  }

  console.log("\ntotals", JSON.stringify(counts));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
