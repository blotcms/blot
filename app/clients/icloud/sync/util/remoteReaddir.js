const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

// The macserver can take a long time to list a directory iCloud is still
// materialising: its ls() gives up on a plain `ls` at 30s, then may spend up
// to 30s in `brctl download` and up to another ~35s polling, so ~95s worst
// case, after which it replies. Each attempt waits longer than that, so we never
// abandon a request the macserver is still working on, and never stack a
// second ls on the same directory. Backing off between attempts gives iCloud
// time to catch up.
const ATTEMPT_TIMEOUT = 120 * 1000;
const DEFAULT_BACKOFF = [5 * 1000, 15 * 1000, 30 * 1000];

// A 4xx (e.g. 404: the directory was renamed or deleted since its parent was
// listed) will not change on retry, and the caller holds the folder lock while
// waiting. Retry only timeouts, connection errors and 5xx.
const isPermanent = (error) => {
  const match = /HTTP error: (\d{3})/.exec(error.message || "");
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const remoteReaddir = async (blogID, path) => {
  const BACKOFF = remoteReaddir.backoff;
  const pathBase64 = Buffer.from(path).toString("base64");

  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    try {
      // readBody keeps the timeout armed while the body is read, so a stalled
      // reply fails the attempt instead of hanging the sync. retries: 1 because
      // we retry here, with a pause.
      const body = await fetch(MAC_SERVER_ADDRESS + "/readdir", {
        readBody: true,
        timeout: ATTEMPT_TIMEOUT,
        retries: 1,
        headers: { Authorization: MACSERVER_AUTH, blogID, pathBase64 },
      });
      const elapsed = Date.now() - startedAt;
      if (attempt > 0 || elapsed > 5000) {
        console.log(
          `iCloud remoteReaddir: ${blogID} ${path} ok after ${elapsed}ms (attempt ${attempt + 1})`
        );
      }
      return JSON.parse(body.toString());
    } catch (error) {
      console.log(
        `iCloud remoteReaddir: ${blogID} ${path} failed after ${Date.now() - startedAt}ms (attempt ${attempt + 1}/${BACKOFF.length + 1}): ${error.message}`
      );
      if (attempt >= BACKOFF.length || isPermanent(error)) throw error;
      await sleep(BACKOFF[attempt]);
    }
  }
};

// overridable so tests don't wait out the real pauses
remoteReaddir.backoff = DEFAULT_BACKOFF;

module.exports = remoteReaddir;
