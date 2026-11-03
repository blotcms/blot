// Fetches a batch of URLs, one after the other in the one jail, so a caller with
// many (an import's images, audio and PDFs) pays for the jail's start once. The
// network code and its limits are ./fetching.js's, shared with fetch-image.js;
// the jail is behind the egress filter (proxy/unit/sandbox/jail.js), so a URL,
// a redirect or a pinned address on an internal address is refused there.
//
// args: { requests: [request, ...] }, at most MAX_REQUESTS. Each request is
//   url          http or https, no credentials
//   kind         what comes back:
//                "text" (the default) the body, decompressed, at most maxBytes
//                  (1 MiB by default, 8 MiB at most);
//                "file" the body's bytes, at most maxBytes (50 MiB by default
//                  and at most), after a check of what it is: check "pdf" must
//                  start like a PDF, check "audio" must not be a web page; with
//                  no check it must not be one either. Never HTML, SVG or script
//                  for a caller to serve as one;
//                "image" a JPEG, PNG, GIF or WebP, decoded and encoded again
//                  as fetch-image does (reencode.js), with its format and size;
//                "html" a web page, parsed here: the request names the fixed
//                  `extract`ion to run on it (./html.js: "og-video", a video
//                  the page names in its Open Graph tags), and what comes
//                  back is that small, validated structure, never the page.
//                  maxBytes is 2 MiB by default and at most; truncate as
//                  for text.
//   ip           connect the first request to this address, with the URL's
//                host as Host (and TLS name), as domain verification needs
//   method       "GET" (the default) or "HEAD"
//   redirect     "follow" (the default, up to 5) or "manual"
//   anyStatus    keep a response whatever its status; otherwise only 2xx
//   truncate     for text and html, stop at maxBytes instead of failing
//   maxBytes     as above
//   timeoutMs    for the whole request with its redirects (20s by default and
//                at most 30s); the batch as a whole has 60s
//   headers      { userAgent, referer, accept }, the only request headers set
//
// meta.results has one entry per request, in order, and outputs one buffer each
// (empty for a request that failed or has no body). An entry is { status,
// headers, kind } with, for an image, format, width and height, and for html
// `extracted`; or { error },
// with status for a refused status, code for a network error and timedOut; or
// { error, deferred: true } for a request not tried or not kept for want of
// room in this batch, which the caller sends again by itself. That is only
// after an earlier request in the batch has kept a body or used up the time: a
// request on its own always has the room for its limits. A URL that can't be fetched is an answer, not a failure
// of the job.

const net = require("net");
const html = require("./html");
const {
  FetchError,
  checkURL,
  checkHeader,
  fetchURL,
  failure,
  isFetchFailure,
  MiB,
  MAX_BODY_BYTES,
  DEADLINE,
  USER_AGENT,
} = require("./fetching");

const MAX_REQUESTS = 32;
const KINDS = ["text", "file", "image", "html"];

const TEXT_DEFAULT_BYTES = 1 * MiB;
const TEXT_MAX_BYTES = 8 * MiB;
const FILE_MAX_BYTES = 50 * MiB;

// With the first body kept, others are kept only while the batch's bodies
// together stay under this, so a batch's memory is its first body's plus this
// (and an image's decode on top, which is what the 256 MiB cgroup is sized for)
const BATCH_BYTES = 16 * MiB;
const BATCH_DEADLINE = 60 * 1000;
const MAX_REQUEST_TIMEOUT = 30 * 1000;

const NAMES = {
  etag: "etag",
  lastModified: "last-modified",
  expires: "expires",
  cacheControl: "cache-control",
  age: "age",
  contentType: "content-type",
  contentDisposition: "content-disposition",
  location: "location",
};

const FULL = "batch is full";

// A web page, SVG or script is never what a caller asked for in a file, and is
// what a caller must not serve from a folder as if it were one
const MARKUP = /^[\s﻿]*(<|\{)|<\s*(html|head|body|svg|script)[\s>]/i;
const sniff = (body) => body.subarray(0, 1024).toString("latin1");

function checkFile(body, check) {
  if (check === "pdf") {
    if (!sniff(body).includes("%PDF-")) throw new FetchError("not a PDF");
    return;
  }
  if (MARKUP.test(sniff(body))) {
    throw new FetchError(check === "audio" ? "not an audio file" : "not a file");
  }
}

function requestHeaders(headers) {
  const given = headers && typeof headers === "object" ? headers : {};
  const result = {
    "User-Agent": checkHeader(given.userAgent) || USER_AGENT,
    Accept: checkHeader(given.accept) || "*/*",
    "Accept-Encoding": "gzip, deflate, br",
  };
  const referer = checkHeader(given.referer);
  if (referer) result.Referer = referer;
  return result;
}

function positive(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new FetchError("invalid limit");
  return Math.min(value, max);
}

// One request. Resolves with { meta, output }; rejects with a FetchError, a
// network error or a bug.
async function fetchOne(request, { held, deadline }) {
  if (!request || typeof request !== "object") throw new FetchError("URL is not allowed");
  const url = checkURL(request.url);
  const kind = request.kind === undefined ? "text" : request.kind;
  if (!KINDS.includes(kind)) throw new FetchError("unknown kind");
  const method = request.method === undefined ? "GET" : request.method;
  if (method !== "GET" && method !== "HEAD") throw new FetchError("method is not allowed");
  const redirect = request.redirect === undefined ? "follow" : request.redirect;
  if (redirect !== "follow" && redirect !== "manual") throw new FetchError("invalid redirect option");
  if (request.ip !== undefined && !net.isIP(request.ip)) {
    throw new FetchError("invalid address");
  }
  if (kind === "html" && !html.EXTRACTIONS.includes(request.extract)) {
    throw new FetchError("unknown extraction");
  }
  if (request.check !== undefined && !["pdf", "audio"].includes(request.check)) {
    throw new FetchError("unknown check");
  }

  // A request gets the whole of its time or none: with less left in the batch
  // it is put off to a jail of its own, not cut short as if the server were slow
  const timeout = positive(request.timeoutMs, DEADLINE, MAX_REQUEST_TIMEOUT);
  if (timeout > deadline - Date.now()) throw new FetchError("batch timed out", { deferred: true });

  let limit =
    kind === "text"
      ? positive(request.maxBytes, TEXT_DEFAULT_BYTES, TEXT_MAX_BYTES)
      : kind === "html"
      ? positive(request.maxBytes, html.MAX_HTML_BYTES, html.MAX_HTML_BYTES)
      : kind === "file"
      ? positive(request.maxBytes, FILE_MAX_BYTES, FILE_MAX_BYTES)
      : MAX_BODY_BYTES;
  let tooLarge =
    kind === "text" || kind === "html"
      ? "response is too large"
      : kind === "file"
      ? "file is too large"
      : "image is too large";
  if (held && held + limit > BATCH_BYTES) {
    limit = Math.max(0, BATCH_BYTES - held);
    tooLarge = FULL;
  }

  const response = await fetchURL(url, {
    headers: requestHeaders(request.headers),
    method,
    redirect,
    ip: request.ip,
    maxBytes: limit,
    tooLarge,
    truncate: (kind === "text" || kind === "html") && request.truncate === true,
    anyStatus: request.anyStatus === true,
    timeout,
    // A server that is slow to answer is as slow as the request allows: a
    // first visit to a domain can wait on its certificate
    headersTimeout: timeout,
    names: NAMES,
  });
  if (response.notModified) return { meta: { status: 304, headers: response.headers, kind }, output: Buffer.alloc(0) };

  const meta = { status: response.status, headers: response.headers, kind };
  let output = response.body;

  if (kind === "file" && method === "GET" && output.length) {
    checkFile(output, request.check);
  } else if (kind === "html") {
    // A HEAD has no body: nothing to extract from
    if (method === "GET") {
      try {
        meta.extracted = html.extract(request.extract, output.toString("utf8"));
      } catch (err) {
        if (err instanceof html.MarkupError) throw new FetchError(err.message);
        throw err;
      }
    }
    output = Buffer.alloc(0);
  } else if (kind === "image") {
    const image = await require("./reencode").reencode(output);
    output = image.data;
    Object.assign(meta, { format: image.format, width: image.width, height: image.height });
  }
  if (response.truncated) meta.truncated = true;

  if (held && held + output.length > BATCH_BYTES) throw new FetchError(FULL, { deferred: true });
  return { meta, output };
}

async function run(args) {
  const requests = args && args.requests;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_REQUESTS) {
    return { meta: { error: "requests must be a list of 1 to " + MAX_REQUESTS }, outputs: [] };
  }

  const deadline = Date.now() + BATCH_DEADLINE;
  const results = [];
  const outputs = [];
  let held = 0;

  for (const request of requests) {
    try {
      const { meta, output } = await fetchOne(request, { held, deadline });
      results.push(meta);
      outputs.push(output);
      held += output.length;
    } catch (err) {
      if (!isFetchFailure(err)) throw err;
      const meta = failure(err);
      // Put off for want of room: the caller sends it again by itself
      if (err.deferred || err.message === FULL) meta.deferred = true;
      results.push(meta);
      outputs.push(Buffer.alloc(0));
    }
  }

  return { meta: { results }, outputs };
}

module.exports = { run, MAX_REQUESTS, BATCH_BYTES, TEXT_MAX_BYTES, FILE_MAX_BYTES };
