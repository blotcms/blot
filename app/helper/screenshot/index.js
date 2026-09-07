const puppeteer = require("puppeteer");
const { dirname } = require("path");
const fs = require("fs-extra");
const Bottleneck = require("bottleneck");
const config = require("config");
const lockfile = require("proper-lockfile");
const retry = require("./retry");
const clfdate = require("helper/clfdate");

// When set, screenshots run in the shared "airlock" container (config/airlock)
// instead of a Chromium we launch ourselves: we attach to its DevTools
// endpoint over the Docker network. The airlock's nftables egress filter is
// what stops a bookmark link from pointing Chromium at an internal address.
const REMOTE_BROWSER_URL = config.airlock && config.airlock.browser_url;

// Chromium deadlocks in Page.captureScreenshot if two tabs of the SAME
// instance capture at once (see the "Browsers are pooled" comment below).
// Bottleneck's concurrency limit only serializes screenshots WITHIN this one
// process - it can't stop blue, green and yellow from each independently
// connect()ing to the one shared airlock Chromium and screenshotting at the
// same time. AIRLOCK_LOCK_PATH is a placeholder file on the data directory
// every container already mounts (config/deploy's DATA_DIRECTORY_ON_SERVER);
// proper-lockfile locks it by atomically mkdir-ing "<path>.lock" beside it,
// giving a cross-container mutex - the same mechanism/dependency app/sync
// already uses to coordinate across containers sharing that directory.
const AIRLOCK_LOCK_PATH = config.data_directory + "/airlock-screenshot";
// Comfortably above the worst-case legitimate hold (PAGE_TIMEOUT plus the
// screenshot/close budgets below), so a lock is never stolen out from under
// a screenshot that's still genuinely in progress.
const AIRLOCK_LOCK_STALE_MS = 45000;

const prefix = () => `${clfdate()} Screenshot:`;

// CONSTANTS
// The defaults are deliberately conservative because most callers screenshot
// live sites one at a time. Batch jobs against a server we control should
// raise them with configure() rather than pay the pacing per screenshot.
const CONCURRENT_SCREENSHOTS = 1;
const MIN_TIME_BETWEEN_OPS = 2000; // 2 seconds
const DEFAULT_RESTART_INTERVAL = 1000 * 60 * 60; // 1 hour
const PAGE_TIMEOUT = 20000;
// Per-screenshot budgets, sized for one screenshot at a time. See configure().
const CLOSE_PAGE_TIMEOUT = 2000;
const SCREENSHOT_TIMEOUT = 2000;
const BROWSER_ARGS = require("./args");

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
//
// In airlock mode (REMOTE_BROWSER_URL set) there is only ever one real
// Chromium process to talk to - it lives in the airlock container, shared
// with every other container connected to it - so "the pool" holds at most
// one entry: a connect()ed wrapper rather than a launch()ed one. See launch()
// and close() below for how the two are told apart, and takeScreenshot() for
// why the remote case additionally isolates each screenshot in its own
// incognito browser context. Bottleneck's concurrency limit only serializes
// screenshots WITHIN this one process, though - it says nothing about
// whatever blue/green/yellow are doing on their own copies of this module -
// so the "never shares an instance with another screenshot" invariant above
// would otherwise break across containers sharing one airlock. See
// AIRLOCK_LOCK_PATH and takeScreenshot() for the cross-container mutex that
// restores it for the remote case.
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

// Cross-container mutex around a remote screenshot - see AIRLOCK_LOCK_PATH
// above. Waits roughly up to AIRLOCK_LOCK_STALE_MS for the current holder
// (a screenshot in another container) to finish or for its lock to go
// stale, rather than failing fast, since the whole point is to wait for
// the shared Chromium to be free rather than to detect contention.
async function acquireAirlockLock() {
  await fs.ensureFile(AIRLOCK_LOCK_PATH);
  return lockfile.lock(AIRLOCK_LOCK_PATH, {
    stale: AIRLOCK_LOCK_STALE_MS,
    retries: { retries: 90, factor: 1, minTimeout: 500 },
  });
}

async function launch() {
  if (REMOTE_BROWSER_URL) {
    console.log(prefix(), "Connecting to airlock browser");

    const instance = await puppeteer.connect({ browserURL: REMOTE_BROWSER_URL });

    return { instance, launchedAt: Date.now(), generation, remote: true };
  }

  console.log(prefix(), "Launching browser");

  const instance = await puppeteer.launch({
    headless: "new",
    devtools: false,
    args: BROWSER_ARGS,
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  // Chrome exits once its last tab closes, so hold one open for the lifetime
  // of the instance.
  const blank = await instance.newPage();
  await blank.goto("about:blank");

  return { instance, launchedAt: Date.now(), generation, remote: false };
}

async function close(browser, reason) {
  console.log(
    prefix(),
    browser.remote ? "Disconnecting from airlock browser:" : "Closing browser:",
    reason
  );

  try {
    if (browser.remote) {
      // The airlock's Chromium is shared infrastructure, not ours to kill -
      // disconnect our client instead of closing the browser out from under
      // every other container connected to the same airlock.
      browser.instance.disconnect();
    } else {
      await browser.instance.close();
    }
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

  // See AIRLOCK_LOCK_PATH above: only needed when there's a shared browser
  // to serialize access to. In launch mode every process already has its
  // own private Chromium, so there's nothing to coordinate and taking this
  // lock would only add unnecessary cross-container serialization - a real
  // regression for the template-gallery batch script's configure() use.
  const unlockAirlock = REMOTE_BROWSER_URL ? await acquireAirlockLock() : null;

  try {
    await takeScreenshotLocked(site, path, options);
  } finally {
    // Outside the inner try so the lock is still released if acquire()
    // itself throws (e.g. the airlock is briefly unreachable) - otherwise
    // it would leak and stall every other container's screenshots until it
    // went stale.
    if (unlockAirlock) {
      await unlockAirlock().catch((error) => {
        console.error(prefix(), "Error releasing airlock screenshot lock:", error);
      });
    }
  }
}

async function takeScreenshotLocked(site, path, options) {
  const browser = await acquire();
  let page = null;
  let context = null;
  let unresponsive = false;

  try {
    if (browser.remote) {
      // The airlock's Chromium is shared with other containers
      // (blue/green/yellow) connected to the same sidecar - an incognito
      // context keeps this screenshot's cookies/cache/storage from leaking
      // into (or being tainted by) theirs, and gives us a single handle to
      // tear down instead of reaching into the browser's global page list.
      context = await browser.instance.createBrowserContext();
      page = await context.newPage();
    } else {
      page = await browser.instance.newPage();
    }
    await page.setUserAgent(DEFAULT_USER_AGENT);

    const viewport = options.mobile ? VIEWPORT.mobile : VIEWPORT.desktop;
    await page.setViewport({
      width: options.width ?? viewport.width,
      height: options.height ?? viewport.height,
      deviceScaleFactor: 2,
    });

    await fs.ensureDir(dirname(path));

    console.log(prefix(), "Navigating browser to", site);
    await page.goto(site, {
      waitUntil: "networkidle0",
      timeout: PAGE_TIMEOUT,
    });

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
    if (context) {
      // Always attempt this, even if closePageWithTimeout already flagged
      // the page as unresponsive: a slow/wedged PAGE doesn't necessarily
      // mean the underlying browser CONNECTION is dead, and in airlock mode
      // close() below only disconnects our client - it cannot destroy the
      // context inside the shared Chromium process. Skipping this
      // unconditionally on `unresponsive` (an earlier fix, for a real
      // hang risk) traded that risk for a worse one: leaking an incognito
      // context - and its storage - in the shared browser on every page
      // timeout, on every retry, until the airlock's own memory limit is
      // exhausted for every container sharing it. withTimeout() bounds the
      // wait either way, so escalate to `unresponsive` only if THIS also
      // fails - that's the actual signal the connection itself is dead.
      try {
        await withTimeout(context.close(), closePageTimeout, "context.close()");
      } catch (error) {
        console.error(prefix(), "Error closing browser context:", error);
        unresponsive = true;
      }
    }

    await release(browser, { unresponsive });
  }
}

// Shutdown handler
async function shutdown() {
  await limiter.stop();
  await cleanup();
}

// Export main function
const screenshot = async (site, path, options = {}) => {
  try {
    return await retry(() =>
      limiter.schedule(() => takeScreenshot(site, path, options))
    );
  } catch (error) {
    console.error(prefix(), "Screenshot failed after retries:", error);
    throw error;
  }
};

module.exports = screenshot;
module.exports.configure = configure;
module.exports.restart = restart;
module.exports.shutdown = shutdown;
