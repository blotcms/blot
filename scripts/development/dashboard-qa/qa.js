// Screenshots and checks dashboard pages. See README.md.
// usage: node qa.js [--slot a|main] [--width 1280] [--shots DIR] [--before "js"] [--eval "js expr"] path [path...]
// --before runs in the page before the screenshot (e.g. open a menu)
// Logs in with a one-time token, visits each path, prints status, timings,
// HTML/CSS/JS bytes, console errors, failed requests; saves a full-page PNG per path.
const puppeteer = require("puppeteer");
const { execSync } = require("child_process");
const path = require("path");
const { target, loginURL } = require("./login");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  if (i === -1) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const slot = opt("--slot", "a");
const width = parseInt(opt("--width", "1280"));
const shots = opt("--shots", path.join(require("os").tmpdir(), "dashboard-qa"));
const evalExpr = opt("--eval", null);
const beforeExpr = opt("--before", null);
const { host, container } = target(slot);
(async () => {
  execSync(`mkdir -p ${shots}`);
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
    args: ["--ignore-certificate-errors"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto(loginURL({ host, container }), { waitUntil: "networkidle2" });
  for (const p of args) {
    const errors = [],
      failed = [],
      bytes = { document: 0, stylesheet: 0, script: 0, other: 0 };
    const onConsole = (m) => {
      if (m.type() === "error" || m.type() === "warning")
        errors.push(m.type() + ": " + m.text().slice(0, 200));
    };
    const onPageError = (e) =>
      errors.push("pageerror: " + String(e.message).slice(0, 200));
    const onFailed = (r) =>
      /__agentation|\/status$/.test(r.url()) ||
      failed.push(
        r.url().slice(0, 120) + " " + (r.failure() && r.failure().errorText)
      );
    const onResponse = async (r) => {
      if (/__agentation|agentation|toolbar\.js/.test(r.url())) return;
      try {
        const t = r.request().resourceType();
        const b = (await r.buffer()).length;
        bytes[bytes[t] === undefined ? "other" : t] += b;
        if (r.status() >= 400)
          failed.push(r.status() + " " + r.url().slice(0, 120));
      } catch (e) {}
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onFailed);
    page.on("response", onResponse);
    const t0 = Date.now();
    // "load", not "networkidle2": pages with a live status stream never go idle
    let res;
    try {
      res = await page.goto(host + p, { waitUntil: "load", timeout: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (e) {
      console.log(`\n== ${p} -> failed: ${e.message}`);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
      continue;
    }
    if (beforeExpr) {
      await page.evaluate(beforeExpr);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return {
        ttfb: Math.round(n.responseStart - n.requestStart),
        dcl: Math.round(n.domContentLoadedEventEnd),
        load: Math.round(n.loadEventEnd),
      };
    });
    const file = path.join(
      shots,
      p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") + `_${width}.png`
    );
    await page.screenshot({ path: file, fullPage: true });
    console.log(`\n== ${p} -> ${res.status()} ${page.url().replace(host, "")}`);
    console.log(
      `   ttfb ${nav.ttfb}ms dcl ${nav.dcl}ms load ${nav.load}ms wall ${Date.now() - t0}ms`
    );
    console.log(
      `   KB html ${Math.round(bytes.document / 1024)} css ${Math.round(bytes.stylesheet / 1024)} js ${Math.round(bytes.script / 1024)} other ${Math.round(bytes.other / 1024)}`
    );
    console.log(`   shot ${file}`);
    errors.forEach((e) => console.log("   ! " + e));
    failed.forEach((e) => console.log("   x " + e));
    if (evalExpr)
      console.log("   eval:", JSON.stringify(await page.evaluate(evalExpr)));
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onFailed);
    page.off("response", onResponse);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
