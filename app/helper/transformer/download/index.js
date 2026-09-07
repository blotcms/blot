const fetch = require("node-fetch");
const fs = require("fs").promises;
const { createWriteStream } = require("fs");
const config = require("config");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const ensure = require("helper/ensure");
const UID = require("helper/makeUid");
const callOnce = require("helper/callOnce");
const tempDir = require("helper/tempDir")();
const nameFrom = require("helper/nameFrom");
const tidy = require("./tidy");
const invalid = require("./invalid");

// When set, remote assets referenced in posts are fetched through the shared
// "airlock" container's forward proxy (config/airlock) instead of straight
// from this process. The airlock's nftables egress filter is what blocks a
// URL - or a redirect from one - that resolves to an internal address, and
// it does so on the real connection IP, so DNS-rebinding does not help an
// attacker. Unset (local dev): fetch directly, no SSRF protection.
const proxyUrl = config.airlock && config.airlock.proxy;
const httpProxyAgent = proxyUrl ? new HttpProxyAgent(proxyUrl) : null;
const httpsProxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
const proxyAgent = proxyUrl
  ? (parsedURL) =>
      parsedURL.protocol === "https:" ? httpsProxyAgent : httpProxyAgent
  : undefined;

const IF_NONE_MATCH = "If-None-Match";
const IF_MODIFIED_SINCE = "If-Modified-Since";
const LAST_MODIFIED = "last-modified";
const CACHE_CONTROL = "cache-control";

const MAX_REDIRECTS = 5;
const TIMEOUT = 5000; // 5s

const debug = function () {}; // console.log || noop for debugging

module.exports = function (url, headers, callback) {
  // Verify the url has a host, and protocol. Pass invalid()'s own error
  // straight through rather than re-interpolating url here - it may
  // contain credentials, and invalid() already returns a message that
  // omits them for exactly that case.
  const invalidReason = invalid(url);
  if (invalidReason) return callback(invalidReason);

  // Sometimes these are null for new urls...
  headers = headers || {};

  ensure(url, "string").and(headers, "object").and(callback, "function");

  // The expire date is greater than now!
  // We don't need to download anything.
  if (isFresh(headers)) return callback(null, null, headers);

  callback = callOnce(callback);

  const path = tempDir + UID(6) + "-" + nameFrom(url);
  const file = createWriteStream(path);

  const options = {
    headers: {
      "User-Agent": "node-fetch",
      ...(headers.etag && { [IF_NONE_MATCH]: headers.etag }),
      ...(headers[LAST_MODIFIED] && {
        [IF_MODIFIED_SINCE]: headers[LAST_MODIFIED]
      })
    },
    redirect: "follow",
    follow: MAX_REDIRECTS,
    timeout: TIMEOUT,
    agent: proxyAgent
  };

  debug("Downloading", url, "to", path, "with fetch headers:");
  debug(print(options.headers));

  fetch(url, options)
    .then(res => {
      debug("Received response:");

      const cacheControl = res.headers.get(CACHE_CONTROL);
      const lastModified = res.headers.get(LAST_MODIFIED);
      const expires = res.headers.get("expires");
      const etag = res.headers.get("etag");
      const age = res.headers.get("age");

      headers[LAST_MODIFIED] = lastModified || headers[LAST_MODIFIED] || "";
      headers.etag = etag || headers.etag || "";
      headers.expires =
        tidy.date(expires) ||
        tidy.expire(cacheControl, age) ||
        headers.expires ||
        "";
      headers.url = headers.url || url;

      if (res.status === 304) {
        debug("  it has 304 unchanged status");
        file.end(); // close the file stream as we won't write anything to it
        return { status: 304, headers };
      }

      if (!res.ok) {
        debug("  it has a bad status code:", res.status);
        // Nobody consumes the body on this path; drop it so the socket
        // isn't held open.
        res.body.destroy();
        throw new Error(res.status);
      }

      debug("  updated latest response headers for status", res.status);

      // node-fetch transparently decompresses gzip/deflate/br bodies but
      // leaves Content-Length describing the *encoded* payload, so a
      // decoded byte count can legitimately differ from it. Only use the
      // header for the truncation check when the body is served identity.
      var contentEncoding = res.headers.get("content-encoding");
      var canCompareLength =
        !contentEncoding || /^identity$/i.test(contentEncoding.trim());

      var expectedLength = Number(res.headers.get("content-length"));
      if (
        !canCompareLength ||
        !Number.isFinite(expectedLength) ||
        expectedLength < 0
      )
        expectedLength = null;

      return new Promise((resolve, reject) => {
        var settled = false;
        var received = 0;
        var idleTimer = null;

        function clearIdle() {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        }

        // Independent streaming watchdog. We do not rely solely on
        // res.body emitting 'error': node-fetch's `timeout` option does
        // not arm a body timer when the stream is consumed via pipe(), and
        // some truncated-body cases (socket destroyed after a partial
        // chunk) can leave the PassThrough open without 'error'/'end'/
        // 'close'. Without this, the promise never settles and the build
        // hangs. This is the ESOCKETIMEDOUT case the old TODO referred to.
        function armIdle() {
          clearIdle();
          idleTimer = setTimeout(function () {
            onError(
              new Error("Download stalled: no data for " + TIMEOUT + "ms")
            );
          }, TIMEOUT);
        }

        function cleanup() {
          clearIdle();
          res.body.removeListener("data", onData);
          file.removeListener("error", onError);
          file.removeListener("finish", onFinish);
          // Deliberately keep the res.body 'error' listener: destroy() and
          // late premature-close errors can still fire after we've settled,
          // and an unhandled 'error' on the stream would crash the process.
          // onError's `settled` guard makes the extra call a no-op.
        }

        function onError(err) {
          if (settled) return;
          settled = true;
          cleanup();
          res.body.unpipe(file);
          // Destroy the response stream, not just unpipe it: an unpiped,
          // unconsumed PassThrough stays paused and backpressures - and so
          // holds open - the underlying HTTP socket, and node-fetch has
          // already cleared its request timeout once headers arrived.
          res.body.destroy();
          file.destroy();
          reject(err);
        }

        function onData(chunk) {
          received += chunk.length;
          armIdle();
        }

        function onFinish() {
          if (settled) return;
          // A body that ends short of its advertised Content-Length is a
          // truncated download, not a success - node-fetch does not always
          // surface this as an 'error'.
          if (expectedLength !== null && received < expectedLength) {
            return onError(
              new Error(
                "Download truncated: received " +
                  received +
                  " of " +
                  expectedLength +
                  " bytes"
              )
            );
          }
          settled = true;
          cleanup();
          resolve({ status: res.status, path, headers });
        }

        res.body.on("error", onError);
        res.body.on("data", onData);
        file.on("error", onError);
        file.on("finish", onFinish);

        armIdle();
        res.body.pipe(file); // start piping the response body to the file
      });
    })
    .then(result => {
      if (!result) return;

      if (result.status === 304) {
        debug("Calling back with cached headers for 304 response:");
        debug(print(result.headers));
        fs.unlink(path).catch(() => {});
        callback(null, null, result.headers);
        return;
      }

      debug("Calling back with path", result.path, "and res headers:");
      debug(print(result.headers));
      callback(null, result.path, result.headers);
    })
    .catch(err => {
      debug("Download error:", err);
      if (!file.destroyed) file.destroy();
      fs.unlink(path).catch(() => {});
      callback(err);
    });
};

function isFresh (existing) {
  return (
    existing &&
    existing.url &&
    existing.expires &&
    new Date(existing.expires) > new Date()
  );
}

function print (obj) {
  return Object.entries(obj)
    .map(([key, value]) => `  ${key}: "${value}"`)
    .join("\n");
}
