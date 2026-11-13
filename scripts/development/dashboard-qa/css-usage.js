// Crawls the dashboard as the local test user and reports, per CSS file, which
// selectors matched no page. See README.md.
// usage: node css-usage.js [--slot a|main] [--max 150] > report.json
/* global document */ // in page.evaluate callbacks, which run in the browser
const puppeteer = require("puppeteer");
const postcss = require("postcss");
const { target, loginURL } = require("./login");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "../../../app/views");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};
const slot = opt("--slot", "a"),
  max = parseInt(opt("--max", "150"));
const { host, container } = target(slot);
const SKIP =
  /log-?out|delete|disconnect|download|remove|reset|cancel|switch|\/status$|authenticate|oauth|redirect\?|\/export\/|pay-subscription|\.(zip|png|jpe?g|gif|pdf|mp4|docx?)$/i;

function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "pickr" ? [] : cssFiles(p);
    return d.name.endsWith(".css") ? [p] : [];
  });
}
// Strip pseudo-classes/elements so the base element can be matched
function base(sel) {
  return (
    sel
      .replace(/::?[a-zA-Z-]+(\((?:[^()]|\([^()]*\))*\))?/g, "")
      .replace(/\s*[>+~]\s*$/, "")
      .trim() || "*"
  );
}
(async () => {
  const files = cssFiles(path.join(ROOT, "css")).concat(
    cssFiles(path.join(ROOT, "partials")),
    cssFiles(path.join(ROOT, "dashboard"))
  );
  const rules = []; // {file, line, selector, base}
  for (const f of files) {
    let rootNode;
    try {
      rootNode = postcss.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      console.error("parse fail", f, e.message);
      continue;
    }
    rootNode.walkRules((r) => {
      if (
        r.parent &&
        r.parent.type === "atrule" &&
        /keyframes/.test(r.parent.name)
      )
        return;
      r.selectors.forEach((s) =>
        rules.push({
          file: path.relative(ROOT, f),
          line: r.source.start.line,
          selector: s,
          base: base(s),
        })
      );
    });
  }
  const bases = [...new Set(rules.map((r) => r.base))];
  const used = new Set();
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
  });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  page.setDefaultTimeout(15000);
  await page.goto(loginURL({ host, container }), {
    waitUntil: "domcontentloaded",
  });
  const queue = ["/sites", "/sites/local", "/sites/account", "/sites/support"],
    seen = new Set(queue),
    visited = [];
  for (const width of [1280, 390]) {
    await page.setViewport({ width, height: 900 });
    const list = width === 1280 ? queue : visited.slice();
    for (let i = 0; i < list.length && visited.length < max * 2; i++) {
      const p = list[i];
      try {
        await page.goto(host + p, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
      } catch (e) {
        continue;
      }
      if (width === 1280) visited.push(p);
      console.error(width, visited.length, p);
      // open <details> so their contents count
      const withTimeout = (pr) =>
        Promise.race([
          pr,
          new Promise((_, r) =>
            setTimeout(() => r(new Error("timeout")), 15000)
          ),
        ]);
      try {
        await withTimeout(
          page.evaluate(() =>
            document.querySelectorAll("details").forEach((d) => (d.open = true))
          )
        );
        var matched = await withTimeout(
          page.evaluate(
            (bases) =>
              bases.filter((b) => {
                try {
                  return !!document.querySelector(b);
                } catch (e) {
                  return false;
                }
              }),
            bases.filter((b) => !used.has(b))
          )
        );
      } catch (e) {
        console.error("skip", p, e.message);
        continue;
      }
      matched.forEach((b) => used.add(b));
      if (width === 1280 && list.length < max) {
        const links = await withTimeout(
          page.evaluate(() =>
            [...document.querySelectorAll("a[href]")].map((a) =>
              a.getAttribute("href")
            )
          )
        ).catch(() => []);
        links.forEach((h) => {
          if (!h || !h.startsWith("/sites")) return;
          h = h.split("#")[0];
          if (SKIP.test(h) || seen.has(h)) return;
          // only one site, and cap folder depth
          if (/^\/sites\/(?!local\b|account|support|default)[^/]+/.test(h))
            return;
          if (h.match(/\/folder\//) && h.split("/").length > 6) return;
          seen.add(h);
          list.push(h);
        });
      }
    }
  }
  await browser.close();
  const jsText = execSync(
    `cat $(find ${ROOT} ${ROOT}/../dashboard -name '*.js' -not -path '*/views-built/*' -not -path '*/tests/*' -not -path '*/pickr/*')`,
    { maxBuffer: 1 << 28 }
  ).toString();
  const report = {};
  rules.forEach((r) => {
    const f = (report[r.file] = report[r.file] || {
      rules: 0,
      used: 0,
      dynamic: [],
      unused: [],
    });
    f.rules++;
    if (used.has(r.base)) return f.used++;
    const classes = (r.base.match(/[.#][a-zA-Z0-9_-]+/g) || []).map((c) =>
      c.slice(1)
    );
    const dyn = classes.length && classes.every((c) => jsText.includes(c));
    (dyn ? f.dynamic : f.unused).push(`${r.line}: ${r.selector}`);
  });
  console.log(JSON.stringify({ visited, report }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
