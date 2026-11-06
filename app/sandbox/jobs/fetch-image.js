// Fetches an image from a URL and re-encodes it, so the app never handles the
// bytes a server sent, compressed or not. In production this runs in a jail
// with a filtered network (proxy/unit/sandbox/jail.js): the egress filter, not
// anything here, keeps it off internal addresses, including after a redirect
// or a DNS rebind. In-process (development, specs) it fetches directly. The
// network code is ./fetching.js, shared with ./fetch.js.
//
// args: { url, etag, lastModified }, the last two for a conditional request.
// A URL that can't be fetched, or isn't an image, is an answer, not a failure
// of the job: meta.error. Otherwise meta is { status, headers, format, width,
// height }, with the image as the one output, or no output for a 304.

const {
  FetchError,
  checkURL,
  checkHeader,
  fetchURL,
  failure,
  isFetchFailure,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
  USER_AGENT,
} = require("./fetching");
const { reencode, MAX_DIMENSION } = require("./reencode");

// The body, once its content encoding is undone, is held to the same limit
const MAX_DECODED_BYTES = MAX_BODY_BYTES;

async function run(args) {
  try {
    if (!args || typeof args !== "object")
      throw new FetchError("URL is not allowed");
    const url = checkURL(args.url);
    const conditional = {
      etag: checkHeader(args.etag, "conditional header"),
      lastModified: checkHeader(args.lastModified, "conditional header"),
    };

    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
    };
    if (conditional.etag) headers["If-None-Match"] = conditional.etag;
    if (conditional.lastModified)
      headers["If-Modified-Since"] = conditional.lastModified;

    const response = await fetchURL(url, {
      headers,
      maxBytes: MAX_BODY_BYTES,
      tooLarge: "image is too large",
    });
    if (response.notModified) {
      return { meta: { status: 304, headers: response.headers }, outputs: [] };
    }

    const image = await reencode(response.body);
    return {
      meta: {
        status: response.status,
        headers: response.headers,
        format: image.format,
        width: image.width,
        height: image.height,
      },
      outputs: [image.data],
    };
  } catch (err) {
    if (isFetchFailure(err)) {
      const meta = failure(err);
      delete meta.timedOut;
      return { meta, outputs: [] };
    }
    throw err;
  }
}

module.exports = {
  run,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
  MAX_DECODED_BYTES,
  MAX_DIMENSION,
};
