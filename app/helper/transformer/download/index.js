const fs = require("fs").promises;
const config = require("config");
const sandbox = require("sandbox");
const ensure = require("helper/ensure");
const UID = require("helper/makeUid");
const tempDir = require("helper/tempDir")();
const nameFrom = require("helper/nameFrom");
const tidy = require("./tidy");
const invalid = require("./invalid");

// Remote assets referenced in posts are user-controlled URLs, so the sandbox's
// fetch-image job (app/sandbox/jobs/fetch-image.js) fetches them, in a jail
// with a filtered network, and re-encodes the image there: this process never
// handles the bytes the server sent, compressed or not. The jail's nftables
// egress filter is what blocks a URL - or a redirect from one - that resolves
// to an internal address, on the real connection IP, so DNS-rebinding does
// not help an attacker. Without a sandbox the job runs in-process and fetches
// directly, which production refuses (config.egress.required).
//
// Resolves with { path, headers }: the path of a temporary file holding the
// image, which the caller removes, and the response's caching headers; or a
// null path when the cached copy is still good (fresh, or a 304).

const LAST_MODIFIED = "last-modified";

const debug = function () {}; // console.log || noop for debugging

module.exports = async function (url, headers) {
  // Verify the url has a host, and protocol. Pass invalid()'s own error
  // straight through rather than re-interpolating url here - it may
  // contain credentials, and invalid() already returns a message that
  // omits them for exactly that case.
  const invalidReason = invalid(url);
  if (invalidReason) throw invalidReason;

  // Fail closed: in production the fetch must happen in the sandbox's jail,
  // never in this process.
  if (!config.sandbox.socket && config.egress.required) {
    throw new Error(
      "transformer/download: refusing to fetch a user-controlled URL - this unit has no sandbox (BLOT_SANDBOX). See app/sandbox/README.md."
    );
  }

  // Sometimes these are null for new urls...
  headers = headers || {};

  ensure(url, "string").and(headers, "object");

  // The expire date is greater than now!
  // We don't need to download anything.
  if (isFresh(headers)) return { path: null, headers };

  const args = {
    url,
    etag: headers.etag || undefined,
    lastModified: headers[LAST_MODIFIED] || undefined,
  };

  debug("Fetching", url, "with", args);

  const { meta, outputs } = await sandbox.run(
    "fetch-image",
    args,
    Buffer.alloc(0)
  );

  if (!meta || typeof meta !== "object")
    throw new Error("fetch-image: no answer");
  // The status for a bad one, as before, or why it isn't an image
  if (meta.error) throw new Error(meta.error);

  const res = meta.headers || {};
  headers[LAST_MODIFIED] = res.lastModified || headers[LAST_MODIFIED] || "";
  headers.etag = res.etag || headers.etag || "";
  headers.expires =
    tidy.date(res.expires) ||
    tidy.expire(res.cacheControl, res.age) ||
    headers.expires ||
    "";
  headers.url = headers.url || url;

  if (meta.status === 304) {
    debug("Resolving with no path", print(headers));
    return { path: null, headers };
  }

  const image = outputs[0];
  if (!image || !image.length) throw new Error("fetch-image: no image");

  const path = tempDir + UID(6) + "-" + nameFrom(url);
  await fs.writeFile(path, image).catch((err) => {
    fs.unlink(path).catch(() => {});
    throw err;
  });

  debug("Resolving with", path, print(headers));
  return { path, headers };
};

function isFresh(existing) {
  return (
    existing &&
    existing.url &&
    existing.expires &&
    new Date(existing.expires) > new Date()
  );
}

function print(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `  ${key}: "${value}"`)
    .join("\n");
}
