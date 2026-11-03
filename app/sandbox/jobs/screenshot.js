// Screenshots of URLs, in one Chromium. Every URL is treated as hostile,
// whoever asks: this runs in a jail with a filtered network
// (proxy/unit/sandbox/jail.js), so no other job's state is in reach and nothing
// is left when it exits.
//
// args: { pages: [{ url, width, height, mobile }, ...] }, at most MAX_PAGES,
// which pay for the jail and Chromium starting (about 2s) once. The pages are
// taken in order, each in a fresh incognito context that is closed before the
// next, so the pages of one batch share no cookies or storage and the memory
// peak stays close to one page's. Pages from different sites may share a
// batch: the jail is what protects the host, and one page breaking another's
// screenshot is accepted.
//
// Returns meta.results, one entry per page in order, and outputs, one buffer
// per page (empty where there is no screenshot). An entry is {} for a PNG, or
// { error, retryable }: a page that can't be screenshotted is an answer, not a
// failure of the job, and retryable says if trying again could help. Pages the
// batch didn't reach (it ran out of time or output room, or Chromium died) are
// { error, retryable: true, deferred: true }, for the caller to send again.
//
// Why pages from different sites, and different customers, share one Chromium
// in one jail: on purpose, to save the ~2.1s start-up per page measured on
// production (3 Nov 2026). What that accepts: a hostile page that compromises
// Chromium (it runs with --no-sandbox inside the jail) can tamper with or break
// the other screenshots of its batch, and one heavy page can kill its batch
// (the client then retries it page by page). What protects the host is the jail
// boundary itself: no secrets or env vars, no data mount, the egress filter, no
// capabilities, seccomp. It is the same for one page or eight, so batching
// doesn't weaken it. The rule: keep that boundary intact above all; isolation
// between jobs inside one jail is not a goal. Don't "fix" cross-site batches.
//
// The single-page form, { url, width, height, mobile }, is still accepted: it
// answers with meta { error, retryable } (or {}) and at most one output.

const sharp = require("sharp");
const ARGS = require("./screenshot-args");

sharp.cache(false);

// How long the page's HTML has to arrive and parse, then how long images, fonts
// and late requests get before we screenshot whatever has rendered. Some pages
// never finish, so the second is best effort.
const PAGE_TIMEOUT = 10000;
const RENDER_GRACE = 8000;
const SCREENSHOT_TIMEOUT = 5000;
// Closing a page's context, and Chromium at the end
const CLOSE_TIMEOUT = 3000;
// What one page can take at worst, closing included
const PAGE_WORST_CASE =
  PAGE_TIMEOUT + RENDER_GRACE + SCREENSHOT_TIMEOUT + CLOSE_TIMEOUT;

const MAX_PAGES = 8;
// A page is started only if it could finish by this long after the job began,
// launching included (the first page always is). Pages take 3-7s typically, so
// a full batch fits with room to spare; a batch of slow pages stops early and
// the rest come back deferred, for the caller to send again, rather than the
// job meeting its limit in jail.js (100s), which would lose the pages done.
const BATCH_BUDGET = 90 * 1000;
// The re-encoded PNGs of a batch together stay under this, which is below the
// job's maxOutputBytes in jail.js and the 64 MiB a reply may hold. A PNG that
// would pass it is deferred, unless it is the first, which has all the room.
const MAX_OUTPUT_BYTES = 56 * 1024 * 1024;

// The two limits above, where the specs can lower them
const limits = { batchBudget: BATCH_BUDGET, maxOutputBytes: MAX_OUTPUT_BYTES };

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
    const error = new Error("invalid dimension");
    error.permanent = true;
    throw error;
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

class StalledError extends Error {}

// Gives up on a promise that doesn't settle in time. What it guards is left to
// finish, or to be killed with Chromium.
function within(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StalledError("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function capture(browser, puppeteer, { url, width, height, mobile }) {
  const defaults = mobile ? VIEWPORT.mobile : VIEWPORT.desktop;
  const viewport = {
    width: dimension(width, defaults.width),
    height: dimension(height, defaults.height),
  };

  // Its own incognito context: nothing from the page before it (cookies,
  // storage, cache), and closing it takes the page's processes with it
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
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
  } finally {
    await within(context.close(), CLOSE_TIMEOUT).catch(() => {});
  }
}

// Chromium's bytes come from a process that ran a hostile page, so decode them
// here, where a bad one can only hurt this job, and send back a PNG that sharp
// wrote: no ancillary chunks, no metadata, and no bigger than the viewport that
// was asked for. A screenshot that doesn't decode is a failed page.
async function reencode(png, maxWidth, maxHeight) {
  return sharp(png, { failOn: "error" })
    .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

function pageFailure(error, puppeteer) {
  const retryable = !(
    error.permanent ||
    error instanceof StalledError ||
    error instanceof puppeteer.TimeoutError ||
    PERMANENT_NAVIGATION_ERROR.test(error.message)
  );
  return { error: String(error.message).slice(0, 200), retryable };
}

const deferred = (error) => ({ error, retryable: true, deferred: true });

// The pages to take, or null if args are not a batch of at most MAX_PAGES
function pagesOf(args) {
  if (!args || typeof args !== "object") return null;
  if (args.pages === undefined) return [args];
  const { pages } = args;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES) return null;
  if (!pages.every((page) => page && typeof page === "object")) return null;
  return pages;
}

async function run(args) {
  const pages = pagesOf(args);
  if (!pages) {
    return { meta: { error: "not a batch of 1 to 8 pages", retryable: false }, outputs: [] };
  }

  const single = args.pages === undefined;
  const results = pages.map((page) =>
    isAllowed(page.url) ? null : { error: "URL is not allowed", retryable: false }
  );
  const outputs = pages.map(() => Buffer.alloc(0));

  // The single form answers in the shape it always had
  const answer = () =>
    single
      ? { meta: results[0], outputs: outputs[0].length ? [outputs[0]] : [] }
      : { meta: { results }, outputs };

  // Nothing to start Chromium for
  if (results.every(Boolean)) return answer();

  const started = Date.now();
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

  let outputBytes = 0;
  let ran = false;
  let stalled = false;

  try {
    for (let i = 0; i < pages.length; i++) {
      if (results[i]) continue;

      if (stalled || !browser.connected) {
        // Chromium died or stopped answering under an earlier page, so this
        // one is told to try again by itself, with a Chromium of its own
        results[i] = deferred("Chromium stopped before this page");
        continue;
      }
      if (ran && Date.now() - started + PAGE_WORST_CASE > limits.batchBudget) {
        results[i] = deferred("the batch ran out of time");
        continue;
      }
      ran = true;

      let shot;
      try {
        shot = await within(capture(browser, puppeteer, pages[i]), PAGE_WORST_CASE);
      } catch (error) {
        if (error instanceof StalledError) stalled = true;
        results[i] = pageFailure(error, puppeteer);
        continue;
      }

      // Now, while Chromium is idle between pages, so no more than one raw
      // PNG is held at a time
      let png;
      try {
        png = await reencode(shot.png, shot.maxWidth, shot.maxHeight);
      } catch (error) {
        results[i] = { error: "the screenshot was not a valid image", retryable: false };
        continue;
      }

      if (outputBytes > 0 && outputBytes + png.length > limits.maxOutputBytes) {
        results[i] = deferred("the batch's screenshots filled the reply");
      } else {
        outputBytes += png.length;
        outputs[i] = png;
        results[i] = {};
      }
    }
  } finally {
    await within(browser.close(), CLOSE_TIMEOUT).catch(() => {});
    // One that would not close is killed; the jail would too, but not before
    // this job had waited on it
    try {
      const child = browser.process();
      if (child && child.exitCode === null) child.kill("SIGKILL");
    } catch (e) {}
  }

  return answer();
}

module.exports = { run, reencode, limits, MAX_PAGES, PAGE_WORST_CASE };
