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

async function launch() {
  const puppeteer = require("puppeteer");
  return puppeteer.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
}

// Renders one case with an open browser. Returns the written path, or null if
// the adapter has nothing for this case.
async function renderCase(browser, c) {
  const result = await adapter.render(c.id);
  if (!result) return null;

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
    await page.setContent(adapter.composePage(c, result, geometry.origin), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const shot = await page.screenshot({ type: "png", omitBackground: false });
    // match the reference's pixel size exactly (fractional logical sizes round up)
    const { width, height } = c.imageSize;
    const out = await sharp(shot)
      .resize({ width, height, position: "left top", fit: "contain", background: "#808080" })
      .png()
      .toBuffer();
    fs.mkdirSync(path.dirname(c.renderedPath), { recursive: true });
    fs.writeFileSync(c.renderedPath, out);
    return c.renderedPath;
  } finally {
    await page.close();
  }
}

async function renderCases(cases, log = () => {}) {
  const browser = await launch();
  const done = [];
  try {
    for (const c of cases) {
      const file = await renderCase(browser, c);
      log(file ? `rendered ${c.id}` : `skipped ${c.id} (no fixture or adapter output)`);
      if (file) done.push(c.id);
    }
  } finally {
    await browser.close();
  }
  return done;
}

module.exports = { renderCases, renderCase, launch };
