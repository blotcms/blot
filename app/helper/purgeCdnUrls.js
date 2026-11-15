const config = require("config");
const fetch = require("node-fetch");
const Bottleneck = require("bottleneck");

// Each purge waits for Bunny to reach every edge (async=false), about 7 s,
// so they run several at a time: started at most 20 a second, 16 in flight.
// Bunny's "async" purges answer at once, but a wildcard one was seen not to
// reach the edge minutes later, so they aren't used.
const limiter = new Bottleneck({
  maxConcurrent: 16,
  minTime: 50,
});

// A purge Bunny never answers would hold its slot, and the caller, forever
const TIMEOUT_MS = 60 * 1000;

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== "function") {
    return 0;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return 0;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryDateMs = Date.parse(retryAfter);
  if (Number.isNaN(retryDateMs)) {
    return 0;
  }

  return Math.max(0, retryDateMs - Date.now());
}

function getBackoffDelayMs(attempt) {
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)
  );
  const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
  return Math.min(MAX_RETRY_DELAY_MS, exponentialDelay + jitter);
}

async function purgeUrlWithRetries(urlToPurge, quiet) {
  const totalAttempts = MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const url = `https://api.bunny.net/purge?url=${encodeURIComponent(urlToPurge)}&async=false`;
      const res = await fetch(url, {
        method: "POST",
        headers: { AccessKey: config.bunny.secret },
        timeout: TIMEOUT_MS,
      });

      if (res.status === 200) {
        if (!quiet)
          console.log(
            `Purged Bunny CDN: ${urlToPurge} (attempt ${attempt}/${totalAttempts})`
          );
        return true;
      }

      if (res.status === 429 && attempt < totalAttempts) {
        const retryAfterMs = parseRetryAfterMs(res.headers);
        const backoffDelayMs = getBackoffDelayMs(attempt);
        const delayMs = Math.max(retryAfterMs, backoffDelayMs);
        await sleep(delayMs);
        continue;
      }

      console.error(
        `Failed to purge Bunny CDN: ${urlToPurge} (attempt ${attempt}/${totalAttempts})`,
        res.status
      );
      return false;
    } catch (err) {
      console.error(
        `Error purging Bunny CDN: ${urlToPurge} (attempt ${attempt}/${totalAttempts})`,
        err
      );
      return false;
    }
  }
}

/**
 * Purge URLs from Bunny CDN cache, several at a time. A URL ending in "*" is
 * a wildcard purge, which reaches the edges but not Perma-Cache.
 * @param {string[]} urls - Array of URLs to purge (will be encoded internally)
 * @param {{ quiet?: boolean }} [options] - quiet: don't log each success
 * @returns {Promise<boolean>} false if any purge failed
 */
async function purgeCdnUrls(urls, options = {}) {
  if (config.environment !== "production") {
    return true;
  }

  if (!config.bunny || !config.bunny.secret) {
    return true;
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    return true;
  }

  const results = await Promise.all(
    urls.map(async (urlToPurge) => {
      try {
        return await limiter.schedule(() =>
          purgeUrlWithRetries(urlToPurge, options.quiet)
        );
      } catch (err) {
        console.error(`Error purging Bunny CDN: ${urlToPurge}`, err);
        return false;
      }
    })
  );

  return results.every(Boolean);
}

module.exports = purgeCdnUrls;
