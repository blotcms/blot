// The network half of the jobs that fetch a URL for the app (fetch-image.js,
// fetch.js), so they share one set of limits: it follows redirects, undoes the
// content encoding and stops at a byte limit on the wire and again once the
// body is decoded. In production those jobs run in a jail with a filtered
// network (proxy/unit/sandbox/jail.js): the egress filter, not anything here,
// keeps them off internal addresses, including after a redirect or a DNS
// rebind, and including an address a caller pins. In-process (development,
// specs) it fetches directly.

const http = require("http");
const https = require("https");
const net = require("net");
const zlib = require("zlib");

const MiB = 1024 * 1024;

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_LENGTH = 512;
const MAX_REDIRECTS = 5;

// The body as it arrives, and once its content encoding is undone, unless the
// caller asks for less. A server can send a few KB of gzip that inflate to
// gigabytes: that stops here.
const MAX_BODY_BYTES = 32 * MiB;

// Each response's headers, then each gap in its body, then the whole fetch with
// its redirects. With the encode these fit in the job's limit in jail.js.
const HEADERS_TIMEOUT = 10 * 1000;
const IDLE_TIMEOUT = 5 * 1000;
const DEADLINE = 20 * 1000;

// The response headers callers get back, under these names
const RESPONSE_HEADERS = {
  etag: "etag",
  lastModified: "last-modified",
  expires: "expires",
  cacheControl: "cache-control",
  age: "age",
};

const DECODERS = {
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

// As node-fetch sent them, which the callers used before these jobs
const USER_AGENT = "node-fetch";

class FetchError extends Error {
  constructor(message, extra) {
    super(message);
    Object.assign(this, extra);
  }
}

function checkURL(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) {
    throw new FetchError("URL is not allowed");
  }
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new FetchError("URL is not allowed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("URL is not allowed");
  }
  if (url.username || url.password) throw new FetchError("URL must not contain credentials");
  return url;
}

// Only printable ASCII: these become request headers
function checkHeader(value, what = "request header") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_HEADER_LENGTH || !/^[\x20-\x7e]*$/.test(value)) {
    throw new FetchError("invalid " + what);
  }
  return value;
}

function remaining(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new FetchError("timed out", { timedOut: true });
  return ms;
}

// One request, resolving with the response once its headers are in. A pinned
// ip is connected to whatever the URL's host resolves to; the Host header and
// the TLS server name stay the URL's.
function request(url, { method, headers, ip, deadline, headersTimeout }) {
  const wait = Math.min(headersTimeout, remaining(deadline));
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const options = { method, headers, agent: false };
    if (ip) {
      const family = net.isIP(ip);
      options.lookup = (hostname, lookupOptions, callback) =>
        lookupOptions && lookupOptions.all
          ? callback(null, [{ address: ip, family }])
          : callback(null, ip, family);
    }
    const req = lib.request(url, options, resolve);
    const timer = setTimeout(() => req.destroy(new FetchError("timed out", { timedOut: true })), wait);
    req.on("response", () => clearTimeout(timer));
    req.on("error", (err) => {
      clearTimeout(timer);
      // Whatever the connection did is the URL's doing, not a bug: keep its
      // message and its code (ECONNREFUSED...) for the caller
      reject(err instanceof FetchError ? err : new FetchError(err.message, { code: err.code }));
    });
    req.end();
  });
}

// The body, with its content encoding undone, within the limits. Past maxBytes
// it fails with tooLarge, or, with truncate, resolves with the first maxBytes.
function readBody(res, { deadline, maxBytes, tooLarge, truncate }) {
  const left = deadline - Date.now();
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers["content-encoding"] || "identity").trim().toLowerCase();
    if (encoding !== "identity" && !DECODERS[encoding]) {
      res.destroy();
      return reject(new FetchError("unsupported content encoding"));
    }

    const declared = Number(res.headers["content-length"]);
    const expected = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    if (!truncate && expected !== null && expected > maxBytes) {
      res.destroy();
      return reject(new FetchError(tooLarge));
    }

    const decoder = encoding === "identity" ? null : DECODERS[encoding]();
    const output = decoder || res;
    const chunks = [];
    let received = 0;
    let decoded = 0;
    let settled = false;
    let truncated = false;
    let idle = null;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(whole);
      if (err) {
        res.destroy();
        if (decoder) decoder.destroy();
        return reject(err);
      }
      if (truncated) {
        res.destroy();
        if (decoder) decoder.destroy();
      }
      resolve({ data: Buffer.concat(chunks, decoded), truncated });
    };

    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(new FetchError("download stalled")), IDLE_TIMEOUT);
    };
    const whole = setTimeout(
      () => finish(new FetchError("timed out", { timedOut: true })),
      Math.max(0, left)
    );

    // Past the limit, either stop with what there is or fail
    const over = () => {
      if (!truncate) return finish(new FetchError(tooLarge));
      truncated = true;
      finish();
    };

    res.on("data", (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes && !truncate) return over();
      armIdle();
    });
    res.on("aborted", () => finish(new FetchError("download was cut short")));
    res.on("error", () => finish(new FetchError("download was cut short")));

    output.on("data", (chunk) => {
      if (settled) return;
      if (decoded + chunk.length > maxBytes) {
        if (truncate && decoded < maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - decoded));
          decoded = maxBytes;
        }
        return over();
      }
      decoded += chunk.length;
      chunks.push(chunk);
    });
    if (decoder) {
      decoder.on("error", () => finish(new FetchError("body could not be decoded")));
      res.pipe(decoder);
    }
    output.on("end", () => {
      if (!res.complete) return finish(new FetchError("download was cut short"));
      if (expected !== null && received < expected) {
        return finish(new FetchError("download was cut short"));
      }
      finish();
    });

    armIdle();
  });
}

function pickHeaders(res, names) {
  const headers = {};
  for (const [name, header] of Object.entries(names)) {
    const value = res.headers[header];
    if (typeof value === "string" && value) headers[name] = value.slice(0, MAX_HEADER_LENGTH);
  }
  return headers;
}

// Fetches a URL, following up to MAX_REDIRECTS redirects, each to an http(s)
// URL with no credentials (unless redirect is "manual"). Options:
//   headers      the request headers
//   method       GET (the default) or HEAD, which has no body
//   redirect     "follow" (the default) or "manual"
//   ip           connect the first request to this address, not the URL's host
//   maxBytes     the body's limit, on the wire and decoded
//   tooLarge     the error for a body over it
//   truncate     stop at maxBytes with what there is instead of failing
//   anyStatus    resolve with a response whatever its status, not just 2xx
//   timeout      ms for the whole fetch, with its redirects
//   headersTimeout  ms to wait for each response's headers (10s by default)
//   names        the response headers to pick, as { name: header }
// Resolves with { status, headers, body, truncated, notModified }, or rejects
// with a FetchError, whose status is the response's for a status refused, or
// a network error with a code.
async function fetchURL(url, options) {
  const {
    headers,
    method = "GET",
    redirect = "follow",
    ip,
    maxBytes = MAX_BODY_BYTES,
    tooLarge = "response is too large",
    truncate = false,
    anyStatus = false,
    timeout = DEADLINE,
    headersTimeout = HEADERS_TIMEOUT,
    names = RESPONSE_HEADERS,
  } = options;
  const deadline = Date.now() + timeout;

  for (let redirects = 0; ; redirects++) {
    // Only the first request is pinned: a redirect goes where the server says
    const res = await request(url, {
      method,
      headers,
      ip: redirects === 0 ? ip : undefined,
      deadline,
      headersTimeout,
    });
    const status = res.statusCode;

    if (redirect === "follow" && status >= 300 && status < 400 && status !== 304 && res.headers.location) {
      res.destroy();
      if (redirects >= MAX_REDIRECTS) throw new FetchError("too many redirects");
      let next;
      try {
        next = new URL(res.headers.location, url).toString();
      } catch (e) {
        throw new FetchError("invalid redirect");
      }
      url = checkURL(next);
      continue;
    }

    if (status === 304) {
      res.destroy();
      return { status, headers: pickHeaders(res, names), notModified: true };
    }

    if (!anyStatus && (status < 200 || status > 299)) {
      res.destroy();
      throw new FetchError(String(status), { status });
    }

    const result = { status, headers: pickHeaders(res, names), truncated: false };
    if (method === "HEAD" || (redirect === "manual" && status >= 300 && status < 400)) {
      res.destroy();
      result.body = Buffer.alloc(0);
      return result;
    }

    const { data, truncated } = await readBody(res, { deadline, maxBytes, tooLarge, truncate });
    result.body = data;
    result.truncated = truncated;
    return result;
  }
}

// The answer for a URL that couldn't be fetched
function failure(err) {
  const meta = { error: String(err.message || "fetch failed").slice(0, 200) };
  if (err.status) meta.status = err.status;
  if (typeof err.code === "string") meta.code = err.code.slice(0, 40);
  if (err.timedOut) meta.timedOut = true;
  return meta;
}

// The URL's doing: a FetchError, or a network or TLS error, which has a code.
// Anything else is a bug, and fails the job.
function isFetchFailure(err) {
  return err instanceof FetchError || typeof err.code === "string";
}

module.exports = {
  FetchError,
  checkURL,
  checkHeader,
  fetchURL,
  failure,
  isFetchFailure,
  MiB,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
  MAX_HEADER_LENGTH,
  DEADLINE,
  USER_AGENT,
};
