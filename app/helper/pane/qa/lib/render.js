// Renders cases with Puppeteer at deviceScaleFactor = the reference's scale,
// with the viewport = reference size / scale on a #808080 desktop, and writes
// the PNG to the case's rendered path. Fonts come from the machine, so the
// pane-qa workflow renders each OS's cases on the matching runner.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const adapter = require("../adapter");
const { referenceGeometry } = require("./geometry");
const { FROZEN_NOW } = require("./constants");

// Freezes Date so scripted dates are stable between renders.
const FREEZE_DATE = `(() => {
  const fixed = new Date(${JSON.stringify(FROZEN_NOW)}).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  window.Date = FrozenDate;
})();`;

// Headless Chrome hides scrollbars by default; the Explorer skin styles its scrollbars
// (they are part of what the reference shows), so its cases need them visible.
//
// --no-sandbox/--disable-setuid-sandbox are needed whenever Chrome runs as root (Chrome
// refuses to start otherwise: "Running as root without --no-sandbox is not supported"). This
// used to be gated on process.env.CI, which every CI *runner* sets but which is NOT forwarded
// into the node.yml test container (its `docker run` has no `-e CI`), so the repo's normal test
// suite (unlike pane-qa, which runs directly on the runner) launched as root with no
// sandbox-disabling args and failed instantly. Pass them unconditionally instead - harmless for
// a non-root launch (pane-qa, local dev). --disable-dev-shm-usage matches
// app/helper/screenshot's launch args: containers get a small /dev/shm by default, which a
// screenshot at 2x device scale can exhaust (AGENTS.md step 8: reproduce with --shm-size=1g).
async function launch(scrollbars = false) {
  const puppeteer = require("puppeteer");
  return puppeteer.launch({
    headless: true,
    ignoreDefaultArgs: scrollbars ? ["--hide-scrollbars"] : [],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

// Which fonts Chrome really used for the page's text, e.g. "Arimo (412), SF
// Pro Text (0)" - so "rendered in Arimo, not Segoe UI Variable" is visible
// instead of a silent fallback. Returns [{ family, glyphs }], most used first.
async function platformFonts(page) {
  const client = await page.createCDPSession();
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "#pane-qa-stage, #pane-qa-stage *" });
    const totals = new Map();
    for (const nodeId of nodeIds.slice(0, 400)) {
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const f of fonts) totals.set(f.familyName, (totals.get(f.familyName) || 0) + f.glyphCount);
    }
    return [...totals].map(([family, glyphs]) => ({ family, glyphs })).sort((a, b) => b.glyphs - a.glyphs);
  } finally {
    await client.detach();
  }
}

// The browser for a case: the given one, or (Windows) a companion with scrollbars shown,
// started on first use and closed with the given browser.
async function browserFor(browser, c) {
  if (c.os !== "windows") return browser;
  if (!browser.__scrollbars) {
    browser.__scrollbars = launch(true);
    const close = browser.close.bind(browser);
    browser.close = async () => (await browser.__scrollbars).close().then(close);
  }
  return browser.__scrollbars;
}

// Screenshots a case's page (full viewport, PNG). `backdrop` replaces the desktop colour
// behind the window; nothing else about the page changes. Returns
// { shot, fonts, rect: { x, y, w, h, radius } } (the window's box in CSS px), or null if
// the adapter has nothing for this case.
async function capture(given, c, { backdrop } = {}) {
  const result = await adapter.render(c.id);
  if (!result) return null;
  const browser = await browserFor(given, c);

  const geometry = await referenceGeometry(c);
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: Math.ceil(c.logicalSize.width),
      height: Math.ceil(c.logicalSize.height),
      deviceScaleFactor: c.scale,
    });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: c.theme }]);
    await page.evaluateOnNewDocument(FREEZE_DATE);
    await page.setContent(adapter.composePage(c, result, geometry.origin, backdrop), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const fonts = await platformFonts(page);
    const rect = await page.$eval("#pane-qa-stage > *", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 };
    });

    const shot = await page.screenshot({ type: "png", omitBackground: false });
    return { shot, fonts, rect };
  } finally {
    await page.close();
  }
}

// Returns { file, fonts }, or null if the adapter has nothing for this case.
async function renderCase(given, c) {
  const captured = await capture(given, c);
  if (!captured) return null;
  const { shot, fonts } = captured;
  // match the reference's pixel size exactly (fractional logical sizes round up)
  const { width, height } = c.imageSize;
  // (cropped, not resized: the screenshot is at most a pixel bigger, and resampling it
  // would blur every hairline)
  const meta = await sharp(shot).metadata();
  const out =
    meta.width >= width && meta.height >= height
      ? await sharp(shot).extract({ left: 0, top: 0, width, height }).png().toBuffer()
      : await sharp(shot).resize({ width, height, position: "left top", fit: "contain", background: "#808080" }).png().toBuffer();
  fs.mkdirSync(path.dirname(c.renderedPath), { recursive: true });
  fs.writeFileSync(c.renderedPath, out);
  return { file: c.renderedPath, fonts };
}

// One case failing (a bad fixture, a timeout) doesn't stop the rest. Returns
// { done: [ids], failed: [{ id, error }] }.
async function renderCases(cases, log = () => {}) {
  const browser = await launch();
  const done = [];
  const failed = [];
  try {
    for (const c of cases) {
      try {
        const result = await renderCase(browser, c);
        if (!result) {
          log(`skipped ${c.id} (no fixture or adapter output)`);
          continue;
        }
        done.push(c.id);
        log(`rendered ${c.id}  fonts: ${result.fonts.map((f) => `${f.family} (${f.glyphs})`).join(", ") || "none"}`);
      } catch (err) {
        failed.push({ id: c.id, error: err.message });
        log(`FAILED ${c.id}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return { done, failed };
}

module.exports = { renderCases, renderCase, capture, launch };
