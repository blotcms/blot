// Puppeteer 25 is ESM; load it when the first browser is acquired.
let puppeteer;
const { dirname } = require("path");
const fs = require("fs-extra");
const Bottleneck = require("bottleneck");
const config = require("config");
const retry = require("./retry");
const clfdate = require("helper/clfdate");
const egress = require("helper/egress");
const sandbox = require("sandbox");

// In production screenshots run in the sandbox's browser jail (app/sandbox,
// takeScreenshotInSandbox below), whose egress filter stops a bookmark link
// from pointing Chromium at an internal address. Without a sandbox, as in
// development, this process launches a Chromium of its own.

const prefix = () => `${clfdate()} Screenshot:`;

// CONSTANTS
// The defaults are deliberately conservative because most callers screenshot
// live sites one at a time. Batch jobs against a server we control should
// raise them with configure() rather than pay the pacing per screenshot.
const CONCURRENT_SCREENSHOTS = 1;
const MIN_TIME_BETWEEN_OPS = 2000; // 2 seconds
const DEFAULT_RESTART_INTERVAL = 1000 * 60 * 60; // 1 hour
// How long the page's HTML has to arrive and parse. Past this the site is
// dead or blocking us, and the screenshot fails.
const PAGE_TIMEOUT = 10000;
// Once the HTML is in, how long images, fonts and late requests get to finish
// before we screenshot whatever has rendered. Some pages never finish (a
// tracking pixel or long poll that hangs), so this is best effort.
const RENDER_GRACE = 8000;
// Navigation errors that will recur on every attempt: the hostname does not
// exist, the certificate is bad, the URL is unusable or redirects forever.
// Resets, refusals and network changes can be transient, so they are retried.
const PERMANENT_NAVIGATION_ERROR =
  /net::ERR_(NAME_NOT_RESOLVED|CERT_[A-Z_]+|SSL_PROTOCOL_ERROR|INVALID_URL|UNSAFE_PORT|UNKNOWN_URL_SCHEME|TOO_MANY_REDIRECTS)\b/;
// Per-screenshot budgets, sized for one screenshot at a time. See configure().
const CLOSE_PAGE_TIMEOUT = 2000;
const SCREENSHOT_TIMEOUT = 2000;
const BROWSER_ARGS = require("sandbox/jobs/screenshot-args");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

const VIEWPORT = {
  desktop: { width: 1260, height: 778 },
  mobile: { width: 400, height: 650 },
};

// State
//
// Browsers are pooled rather than shared: Chromium deadlocks in
// Page.captureScreenshot when several tabs of one instance capture at the same
// time, so a screenshot never shares an instance with another screenshot. At
// the default concurrency of one that is a single long-lived browser.
const idle = [];
let poolSize = CONCURRENT_SCREENSHOTS;
// Bumped by restart() and shutdown() so browsers currently taking a
// screenshot are closed when they come back rather than being reused.
let generation = 0;
let closePageTimeout = CLOSE_PAGE_TIMEOUT;
let screenshotTimeout = SCREENSHOT_TIMEOUT;

const limiter = new Bottleneck({
  maxConcurrent: CONCURRENT_SCREENSHOTS,
  minTime: MIN_TIME_BETWEEN_OPS,
});

// Lets a batch caller trade the production pacing for throughput. Anything
// omitted keeps its current value.
function configure({ concurrency, minTime } = {}) {
  const settings = {};

  if (concurrency !== undefined) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Screenshot concurrency must be a positive integer");
    }

    settings.maxConcurrent = concurrency;
    poolSize = concurrency;

    // Browsers rendering at the same time compete for the same cores, so each
    // screenshot and page close takes roughly as many times longer as there
    // are of them. Scaling the budgets keeps them a guard against a wedged
    // page rather than a limit on how many screenshots can run at once.
    closePageTimeout = CLOSE_PAGE_TIMEOUT * concurrency;
    screenshotTimeout = SCREENSHOT_TIMEOUT * concurrency;
  }

  if (minTime !== undefined) {
    if (!Number.isFinite(minTime) || minTime < 0) {
      throw new Error("Screenshot minTime must be zero or greater");
    }
    settings.minTime = minTime;
  }

  if (Object.keys(settings).length) limiter.updateSettings(settings);

  return { ...settings, closePageTimeout, screenshotTimeout };
}

const PREVIEW_RELOAD_PATH = "/__blot/preview/reload";

function validateOptions(options) {
  const validatedOptions = { ...options };
  if (options.width && typeof options.width !== "number") {
    throw new Error("Width must be a number");
  }
  if (options.height && typeof options.height !== "number") {
    throw new Error("Height must be a number");
  }
  return validatedOptions;
}

async function launch() {
  puppeteer = await import("puppeteer");

  console.log(prefix(), "Launching browser");

  const instance = await puppeteer.launch({
    headless: true,
    devtools: false,
    args: BROWSER_ARGS,
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  // Chrome exits once its last tab closes, so hold one open for the lifetime
  // of the instance.
  const blank = await instance.newPage();
  await blank.goto("about:blank");

  return { instance, launchedAt: Date.now(), generation };
}

async function close(browser, reason) {
  console.log(prefix(), "Closing browser:", reason);

  try {
    await browser.instance.close();
  } catch (error) {
    console.error(prefix(), "Error closing browser:", error);
  }
}

async function acquire() {
  let browser;

  // A browser can also die while sitting idle (e.g. it crashed mid-screenshot
  // and was returned to the pool before that was noticed - see release()).
  // Skip past any dead entries rather than handing one out.
  while ((browser = idle.pop())) {
    if (browser.instance.connected) return browser;
    await close(browser, "found disconnected in the pool");
  }

  return launch();
}

// Returns a browser to the pool, or closes it if it should not be used again.
async function release(browser, { unresponsive } = {}) {
  if (unresponsive) return close(browser, "browser stopped responding");

  // A crash or disconnect (e.g. OOM) throws a plain Error from whatever
  // puppeteer call was in flight, not the local TimeoutError, so
  // `unresponsive` is never set for it. Check the browser itself: putting a
  // dead instance back in the pool would fail every screenshot that
  // acquire()s it next, since nothing else ever notices it is gone.
  if (!browser.instance.connected) {
    return close(browser, "browser is no longer connected");
  }

  if (browser.generation !== generation) {
    return close(browser, "restarted since this browser was launched");
  }

  if (Date.now() - browser.launchedAt >= DEFAULT_RESTART_INTERVAL) {
    return close(browser, "scheduled restart");
  }

  // More browsers than the pool holds means the concurrency was lowered, or
  // that something ran outside the limiter. Either way, don't keep the extras.
  if (idle.length >= poolSize) {
    return close(browser, "surplus to the configured concurrency");
  }

  idle.push(browser);
}

async function restart() {
  // Browsers busy taking a screenshot are closed by release() instead, so a
  // restart never pulls a page out from under a screenshot in progress.
  generation++;

  await Promise.all(
    idle.splice(0).map((browser) => close(browser, "restart requested"))
  );
}

async function cleanup() {
  generation++;

  await Promise.all(
    idle.splice(0).map((browser) => close(browser, "shutting down"))
  );
}

class TimeoutError extends Error {}

// Clearing the timer matters: a timeout left running after the operation it
// guarded succeeded would report a healthy browser as wedged later on.
function withTimeout(promise, ms, description) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new TimeoutError(`Timeout calling ${description} after ${ms}ms`)),
      ms
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Resolves to true if the page could not be closed in time, which means the
// browser has stopped answering and has to be thrown away.
async function closePageWithTimeout(page) {
  try {
    await withTimeout(page.close(), closePageTimeout, "page.close()");
    return false;
  } catch (error) {
    console.error(prefix(), "Error closing page:", error);

    if (error instanceof TimeoutError) {
      // Coaxing the page through the same unresponsive connection would hang
      // too. Closing the browser is what reclaims it.
      return true;
    }

    // Otherwise the page may well still be open. Try once more to stop it,
    // under a deadline of its own so this cannot become the hang it is
    // recovering from.
    try {
      await withTimeout(
        page.evaluate(() => window.stop()).then(() => page.close()),
        closePageTimeout,
        "forced page cleanup"
      );
      return false;
    } catch (e) {
      console.error(prefix(), "Failed forced page cleanup:", e);
      return e instanceof TimeoutError;
    }
  }
}

async function screenshotWithTimeout(page, path) {
  try {
    await withTimeout(
      page.screenshot({
        path,
        type: "png",
        omitBackground: true,
      }),
      screenshotTimeout,
      "page.screenshot()"
    );
  } catch (error) {
    // Cleanup partial screenshot file
    try {
      await fs.remove(path);
    } catch (e) {
      console.error(prefix(), "Error cleaning up partial screenshot:", e);
    }

    const failure = new Error(`Failed to take screenshot: ${error.message}`);
    // A screenshot that never comes back is the browser's fault, not the
    // site's, so let the caller retry against a fresh one.
    failure.unresponsive = error instanceof TimeoutError;
    throw failure;
  }
}

async function takeScreenshot(site, path, options = {}) {
  options = validateOptions(options);
  const browser = await acquire();
  let page = null;
  let unresponsive = false;

  try {
    page = await browser.instance.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);

    const viewport = options.mobile ? VIEWPORT.mobile : VIEWPORT.desktop;
    await page.setViewport({
      width: options.width ?? viewport.width,
      height: options.height ?? viewport.height,
      deviceScaleFactor: 2,
    });

    await fs.ensureDir(dirname(path));

    // Preview pages hold an EventSource open at /__blot/preview/reload so the
    // template editor can refresh them. Block that request before it reaches
    // the server; the network never goes idle while the stream is open.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === PREVIEW_RELOAD_PATH) return request.abort();
      return request.continue();
    });

    console.log(prefix(), "Navigating browser to", site);
    try {
      await page.goto(site, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });
    } catch (error) {
      // A site that sends no page in PAGE_TIMEOUT, or fails in a way that
      // cannot change, will not do better on the next attempt.
      if (
        error instanceof puppeteer.TimeoutError ||
        PERMANENT_NAVIGATION_ERROR.test(error.message)
      ) {
        error.retryable = false;
      }
      throw error;
    }

    // Best effort: wait for the load event and then a quiet network, sharing
    // one RENDER_GRACE budget. A page that never finishes is screenshotted
    // as it rendered.
    const renderDeadline = Date.now() + RENDER_GRACE;
    try {
      // A string, not an arrow function: puppeteer serializes functions with
      // toString(), and under nyc (CI coverage) that source carries counters
      // which do not exist in the page, so the wait would never resolve.
      await page.waitForFunction('document.readyState === "complete"', {
        timeout: RENDER_GRACE,
      });
      // A timeout of 0 would mean wait forever
      const remaining = Math.max(1, renderDeadline - Date.now());
      await page.waitForNetworkIdle({
        idleTime: 500,
        timeout: remaining,
        concurrency: 0,
      });
    } catch (error) {
      if (!(error instanceof puppeteer.TimeoutError)) throw error;
      console.log(prefix(), "Page never finished, screenshotting what rendered");
    }

    console.log(prefix(), "Taking screenshot of", site, "to", path);
    await screenshotWithTimeout(page, path);
  } catch (error) {
    console.error(prefix(), "Error during screenshot:", error);
    if (error.unresponsive) unresponsive = true;
    throw error;
  } finally {
    if (page) {
      console.log(prefix(), "closing page");
      if (await closePageWithTimeout(page)) unresponsive = true;
    }
    await release(browser, { unresponsive });
  }
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

// Pages from different sites and customers deliberately share a batch, hence
// one Chromium in one jail, to save the ~2.1s start-up per page (measured on
// production, 3 Nov 2026). A hostile page can tamper with or break the others
// of its batch, or kill it (each page is then retried alone); that is accepted,
// because the jail boundary (no secrets, egress filter, no capabilities,
// seccomp) protects the host and is the same for one page or eight. Keep that
// boundary intact; isolation between screenshots is not a goal. Don't split
// batches by site or customer. See app/sandbox/README.md.
//
// Screenshots in the sandbox are batched. A job costs about 2s before it
// touches a page (the jail, Chromium, the re-encode), so requests that arrive
// close together share one job of up to BATCH_MAX pages (the job's limit,
// app/sandbox/jobs/screenshot.js), taken one after the other in one Chromium.
//
// A request waits at most COALESCE_MS for company before its batch goes out,
// and a batch that reaches BATCH_MAX goes at once. Only one batch is out at a
// time per process, because the unit's browser cgroup runs one job at a time
// anyway: requests that arrive meanwhile wait for it and go out together the
// moment it is done, without the window. The pacing of the limiter, meant for
// a browser of this process's own, is not applied.
const BATCH_MAX = 8;
const COALESCE_MS = 150;
// The job takes 64 KiB of arguments; a batch of long URLs is cut short of it
const BATCH_ARGS_BYTES = 48 * 1024;

// The job as a whole failed rather than a page: it ran out of time or memory,
// or its reply was too big. In a batch the cause is one of its pages, or all
// of them together, so each page is tried again on its own.
const JOB_LIMIT_CODES = ["SANDBOX_TIMEOUT", "SANDBOX_KILLED", "SANDBOX_OUTPUT_TOO_LARGE", "SANDBOX_INPUT_TOO_LARGE"];

// A batch the broker answered busy is sent again this often, this far apart
const BUSY_TRIES = 6;
const BUSY_DELAY_MS = 5000;

let waiting = []; // { args, path, resolve, reject }
let windowTimer = null;
let batchRunning = false;

function takeScreenshotInSandbox(site, path, options) {
  return new Promise((resolve, reject) => {
    let args;
    try {
      const { width, height, mobile } = validateOptions(options);
      args = { url: site, width, height, mobile: !!mobile };
    } catch (error) {
      error.retryable = false;
      return reject(error);
    }

    console.log(prefix(), "Taking screenshot of", site, "in the sandbox");
    waiting.push({ args, path, resolve, reject });
    schedule();
  });
}

function schedule() {
  if (batchRunning || !waiting.length) return;
  if (waiting.length >= BATCH_MAX) return sendBatch();
  if (!windowTimer) windowTimer = setTimeout(sendBatch, COALESCE_MS);
}

function sendBatch() {
  clearTimeout(windowTimer);
  windowTimer = null;
  if (batchRunning || !waiting.length) return;

  const items = [];
  let bytes = 0;
  while (waiting.length && items.length < BATCH_MAX) {
    bytes += Buffer.byteLength(JSON.stringify(waiting[0].args));
    if (items.length && bytes > BATCH_ARGS_BYTES) break;
    items.push(waiting.shift());
  }

  batchRunning = true;
  runBatch(items)
    .catch((error) => console.error(prefix(), "Screenshot batch failed:", error))
    .finally(() => {
      batchRunning = false;
      // What came in while it ran goes out now, with no window
      if (waiting.length) sendBatch();
    });
}

// Settles every item in the batch, one way or another
async function runBatch(items) {
  console.log(prefix(), `Sending a batch of ${items.length} to the sandbox`);

  let result;
  try {
    result = await sandbox.run(
      "screenshot",
      { pages: items.map((item) => item.args) },
      Buffer.alloc(0)
    );
  } catch (error) {
    if (error.code === "SANDBOX_BUSY") {
      // The browser is taken and the queue was full or waited out: backpressure,
      // not the pages' doing. Back they go, a few times, before they fail.
      const fresh = items.filter((item) => (item.busy = (item.busy || 0) + 1) <= BUSY_TRIES);
      for (const item of items) if (!fresh.includes(item)) item.reject(error);
      if (fresh.length) {
        const timer = setTimeout(() => {
          waiting.unshift(...fresh);
          schedule();
        }, BUSY_DELAY_MS);
        timer.unref();
      }
      return;
    }
    if (JOB_LIMIT_CODES.includes(error.code)) {
      if (items.length > 1) {
        // One heavy or hung page must only cost itself. Each is sent alone,
        // one after the other, as the browser cgroup holds one job at a time.
        for (const item of items) await runBatch([item]);
        return;
      }
      // Alone, so it is the page's doing. Trying again would hold the unit's
      // one browser for as long again.
      error.retryable = false;
    }
    for (const item of items) item.reject(error);
    return;
  }

  const results = result.meta && result.meta.results;
  if (result.meta && result.meta.error) {
    const error = new Error(result.meta.error);
    error.retryable = result.meta.retryable === true;
    for (const item of items) item.reject(error);
    return;
  }
  if (
    !Array.isArray(results) ||
    results.length !== items.length ||
    result.outputs.length !== items.length
  ) {
    const error = new Error("The sandbox answered a different number of pages");
    error.retryable = false;
    for (const item of items) item.reject(error);
    return;
  }

  const again = [];
  await Promise.all(
    items.map(async (item, i) => {
      const entry = results[i] || {};

      if (entry.error) {
        // Not reached, for want of time or room: next in line for the next
        // batch, not a failed attempt
        if (entry.deferred === true && items.length > 1) return again.push(item);
        const error = new Error(entry.error);
        error.retryable = entry.retryable === true;
        return item.reject(error);
      }

      // The bytes come from a process that ran the page, so only write them if
      // they at least claim to be a PNG.
      const png = result.outputs[i];
      if (!png || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        const error = new Error("The sandbox did not return a PNG");
        error.retryable = false;
        return item.reject(error);
      }

      try {
        await fs.ensureDir(dirname(item.path));
        await fs.writeFile(item.path, png);
      } catch (error) {
        return item.reject(error);
      }
      item.resolve();
    })
  );

  // Ahead of whatever has arrived since, which sendBatch() sends next
  waiting.unshift(...again);
}

// Shutdown handler
async function shutdown() {
  await limiter.stop();
  await cleanup();
}

// Export main function
const screenshot = async (site, path, options = {}) => {
  // Fail closed: a user-controlled URL (options.untrusted, set by
  // build/plugins/linkScreenshot) must be screenshotted inside the sandbox,
  // never a Chromium we launch ourselves. In production, refuse rather than
  // fall back to puppeteer.launch(). Trusted callers (app/templates/screenshots.js
  // - URLs built from config.host, no user input) don't set the flag.
  if (options.untrusted && !config.sandbox.browser) {
    egress.assertBrowserReady("build/plugins/linkScreenshot");
  }

  // In the sandbox the batching is the pacing, so no limiter
  const take = config.sandbox.browser
    ? () => takeScreenshotInSandbox(site, path, options)
    : () => limiter.schedule(() => takeScreenshot(site, path, options));

  try {
    return await retry(take);
  } catch (error) {
    console.error(prefix(), "Screenshot failed after retries:", error);
    throw error;
  }
};

module.exports = screenshot;
module.exports.configure = configure;
module.exports.MIN_TIME_BETWEEN_OPS = MIN_TIME_BETWEEN_OPS;
module.exports.BATCH_MAX = BATCH_MAX;
module.exports.COALESCE_MS = COALESCE_MS;
module.exports.BUSY_DELAY_MS = BUSY_DELAY_MS;
module.exports.restart = restart;
module.exports.shutdown = shutdown;
