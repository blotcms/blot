// Capture screenshots. Runs ON THE HOST, not in the container.
//
// The container cannot reach the development site: Docker's embedded DNS
// forwards *.blot to the host resolver, which answers 127.0.0.1 — correct on the
// host, but inside the container that is the container itself, and nginx is a
// different container. Verified: connection refused.
//
// For the same reason it cannot use the airlock (BLOT_AIRLOCK_BROWSER_URL, the
// shared Chromium app/helper/screenshot connects to): the airlock's egress
// filter rejects private and loopback addresses, and the local site is one, so
// it could never load the pages this script exists to capture. It launches its
// own browser on the host instead: puppeteer's own download by default, or
// whichever Chrome PUPPETEER_EXECUTABLE_PATH points at. Nothing here needs the
// Chromium in the Docker image.
//
//   node screenshot.js <url> <output.png> [--mobile]
//   node screenshot.js --batch < targets.json
//
// Batch mode takes [{ url, path, mobile?, label? }] on stdin and reuses a single
// browser across every shot, which matters when capturing several pages.
//
// Behaviour is modelled on app/helper/screenshot rather than imported from it —
// that module's args.js is tuned for the Alpine container's Chromium.

const fs = require("fs-extra");
const { dirname } = require("path");

const VIEWPORTS = {
  desktop: { width: 1260, height: 778 },
  mobile: { width: 400, height: 650 },
};

const DEVICE_SCALE_FACTOR = 2;
const PAGE_TIMEOUT = 30000;
const SETTLE_AFTER_LOAD = 500;
const ATTEMPTS = 2;

// A real user agent: some sites serve a degraded page, or nothing at all, to
// anything that announces itself as headless.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

let browser = null;

async function getBrowser() {
  if (browser) return browser;

  const puppeteer = await import("puppeteer");
  browser = await puppeteer.launch({
    headless: true,
    // The development site uses a mkcert certificate. It is trusted system-wide
    // only where `mkcert -install` has run, and Chromium keeps its own store, so
    // do not let a certificate warning masquerade as a broken page.
    acceptInsecureCerts: true,
    args: ["--hide-scrollbars", "--disable-gpu", "--font-render-hinting=none"],
  });

  return browser;
}

async function close() {
  if (!browser) return;
  const closing = browser;
  browser = null;
  await closing.close().catch(() => {});
}

async function captureOnce(target) {
  const viewport = target.mobile ? VIEWPORTS.mobile : VIEWPORTS.desktop;
  const instance = await getBrowser();
  const page = await instance.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ ...viewport, deviceScaleFactor: DEVICE_SCALE_FACTOR });

    const response = await page.goto(target.url, {
      waitUntil: "networkidle0",
      timeout: PAGE_TIMEOUT,
    });

    // Let webfonts and late layout shifts land before we shoot.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_LOAD));

    await fs.ensureDir(dirname(target.path));
    await page.screenshot({ path: target.path, type: "png", fullPage: !!target.fullPage });

    return {
      ok: true,
      status: response ? response.status() : null,
      path: target.path,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function capture(target) {
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await captureOnce(target);
    } catch (err) {
      lastError = err;

      // A crashed or disconnected browser will not recover on its own.
      if (attempt < ATTEMPTS) await close();
    }
  }

  return { ok: false, error: lastError ? lastError.message : "unknown", path: target.path };
}

// Capture every target with one browser. Never throws: a source site that blocks
// headless browsers or times out should not abort a run, it should be reported.
async function captureAll(targets) {
  const results = [];

  try {
    for (const target of targets) {
      const result = await capture(target);
      results.push({ label: target.label || target.url, ...result });
    }
  } finally {
    await close();
  }

  return results;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--batch") {
    const input = await readStdin();
    const targets = JSON.parse(input || "[]");
    const results = await captureAll(targets);
    console.log(JSON.stringify(results, null, 2));
    // Exit 0 even on individual failures — the caller decides what is fatal.
    return;
  }

  const [url, path] = args;

  if (!url || !path) {
    console.error("Usage: node screenshot.js <url> <output.png> [--mobile]");
    console.error("       node screenshot.js --batch < targets.json");
    process.exit(1);
  }

  const results = await captureAll([
    { url, path, mobile: args.includes("--mobile") },
  ]);

  const [result] = results;

  if (!result.ok) {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }

  console.log(result.path);
}

if (require.main === module) {
  main().catch(async (err) => {
    await close();
    console.error("[screenshot]", err.message);
    process.exit(1);
  });
}

module.exports = { capture, captureAll, close, VIEWPORTS };
