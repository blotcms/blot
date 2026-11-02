// A screenshot of a URL, in its own Chromium. Every URL is treated as hostile,
// whoever asks: this runs in a jail with a filtered network
// (proxy/unit/sandbox/jail.js), so no other job's state is in reach and nothing
// is left when it exits. args: { url, width, height, mobile }. A page that
// can't be screenshotted is an answer, not a failure of the job: it comes back
// as meta.error, and meta.retryable says if trying again could help.

const sharp = require("sharp");
const ARGS = require("./screenshot-args");

sharp.cache(false);

// How long the page's HTML has to arrive and parse, then how long images, fonts
// and late requests get before we screenshot whatever has rendered. Some pages
// never finish, so the second is best effort. Together with launching and
// closing Chromium these have to fit in the job's limit in jail.js.
const PAGE_TIMEOUT = 10000;
const RENDER_GRACE = 8000;
const SCREENSHOT_TIMEOUT = 5000;

const DEVICE_SCALE_FACTOR = 2;
const MAX_DIMENSION = 4096;

const VIEWPORT = {
  desktop: { width: 1260, height: 778 },
  mobile: { width: 400, height: 650 },
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

// Preview pages hold an EventSource open so the template editor can refresh
// them; the network never goes idle while it is open.
const PREVIEW_RELOAD_PATH = "/__blot/preview/reload";

// Errors that will recur on every attempt: the hostname does not exist, the
// certificate is bad, the URL is unusable or redirects forever. Resets,
// refusals and network changes can be transient.
const PERMANENT_NAVIGATION_ERROR =
  /net::ERR_(NAME_NOT_RESOLVED|CERT_[A-Z_]+|SSL_PROTOCOL_ERROR|INVALID_URL|UNSAFE_PORT|UNKNOWN_URL_SCHEME|TOO_MANY_REDIRECTS)\b/;

function dimension(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new Error("invalid dimension");
  }
  return value;
}

// The deploy's verify check launches Chromium on about:blank. Anything else has
// to be a web page: never file:, whatever a caller was handed.
function isAllowed(url) {
  if (url === "about:blank") return true;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch (e) {
    return false;
  }
}

async function capture(browser, puppeteer, { url, width, height, mobile }) {
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULT_USER_AGENT);

  const defaults = mobile ? VIEWPORT.mobile : VIEWPORT.desktop;
  const viewport = {
    width: dimension(width, defaults.width),
    height: dimension(height, defaults.height),
  };
  await page.setViewport({
    ...viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch (e) {}
    if (pathname === PREVIEW_RELOAD_PATH) return request.abort();
    return request.continue();
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });

  // A string, not an arrow function: puppeteer serializes functions with
  // toString(), and under nyc (CI coverage) that source carries counters which
  // do not exist in the page.
  const deadline = Date.now() + RENDER_GRACE;
  try {
    await page.waitForFunction('document.readyState === "complete"', {
      timeout: RENDER_GRACE,
    });
    await page.waitForNetworkIdle({
      idleTime: 500,
      timeout: Math.max(1, deadline - Date.now()),
      concurrency: 0,
    });
  } catch (error) {
    if (!(error instanceof puppeteer.TimeoutError)) throw error;
  }

  return {
    png: Buffer.from(
      await page.screenshot({
        type: "png",
        omitBackground: true,
        timeout: SCREENSHOT_TIMEOUT,
      })
    ),
    // What the viewport was, in the pixels of the screenshot
    maxWidth: viewport.width * DEVICE_SCALE_FACTOR,
    maxHeight: viewport.height * DEVICE_SCALE_FACTOR,
  };
}

// Chromium's bytes come from a process that ran a hostile page, so decode them
// here, where a bad one can only hurt this job, and send back a PNG that sharp
// wrote: no ancillary chunks, no metadata, and no bigger than the viewport that
// was asked for. A screenshot that doesn't decode is a failed job.
async function reencode(png, maxWidth, maxHeight) {
  return sharp(png, { failOn: "error" })
    .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

function pageFailure(error, puppeteer) {
  const retryable = !(
    error instanceof puppeteer.TimeoutError ||
    PERMANENT_NAVIGATION_ERROR.test(error.message)
  );
  return { meta: { error: String(error.message).slice(0, 200), retryable }, outputs: [] };
}

async function run(args) {
  if (!args || !isAllowed(args.url)) {
    return { meta: { error: "URL is not allowed", retryable: false }, outputs: [] };
  }

  // Puppeteer 25 is ESM
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: "shell",
    pipe: true,
    args: ARGS,
    ignoreDefaultArgs: ["--disable-extensions"],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  let shot;
  try {
    shot = await capture(browser, puppeteer, args);
  } catch (error) {
    return pageFailure(error, puppeteer);
  } finally {
    await browser.close().catch(() => {});
  }

  // After Chromium has gone, so its memory and sharp's are never held together
  const png = await reencode(shot.png, shot.maxWidth, shot.maxHeight);
  return { meta: {}, outputs: [png] };
}

module.exports = { run, reencode };
