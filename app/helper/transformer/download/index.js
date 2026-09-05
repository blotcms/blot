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

      headers[LAST_MODIFIED] = lastModified || headers[LAST_MODIFIED] || "";
      headers.etag = etag || headers.etag || "";
      headers.expires =
        tidy.date(expires) ||
        tidy.expire(cacheControl) ||
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
        throw new Error(res.status);
      }

      debug("  updated latest response headers for status", res.status);
      res.body.pipe(file); // start piping the response body to the file

      return new Promise((resolve, reject) => {
        file.on("finish", () => resolve({ status: res.status, path, headers }));
        file.on("error", reject);
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
      file.close();
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
