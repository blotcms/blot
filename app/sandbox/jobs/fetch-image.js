// Fetches an image from a URL and re-encodes it, so the app never handles the
// bytes a server sent, compressed or not. In production this runs in a jail
// with a filtered network (proxy/unit/sandbox/jail.js): the egress filter, not
// anything here, keeps it off internal addresses, including after a redirect
// or a DNS rebind. In-process (development, specs) it fetches directly.
//
// args: { url, etag, lastModified }, the last two for a conditional request.
// A URL that can't be fetched, or isn't an image, is an answer, not a failure
// of the job: meta.error. Otherwise meta is { status, headers, format, width,
// height }, with the image as the one output, or no output for a 304.

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const sharp = require("sharp");

sharp.cache(false);

const MiB = 1024 * 1024;

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_LENGTH = 512;
const MAX_REDIRECTS = 5;

// The body as it arrives, and once its content encoding is undone. A server
// can send a few KB of gzip that inflate to gigabytes: that stops here.
const MAX_BODY_BYTES = 32 * MiB;
const MAX_DECODED_BYTES = 32 * MiB;
// A re-encoded image can be larger than the one that came in
const MAX_OUTPUT_BYTES = 48 * MiB;

// Each response's headers, then each gap in its body, then the whole fetch with
// its redirects. With the encode these fit in the job's limit in jail.js.
const HEADERS_TIMEOUT = 10 * 1000;
const IDLE_TIMEOUT = 5 * 1000;
const DEADLINE = 20 * 1000;

// What the callers' transforms take (app/build/plugins/image/optimize.js,
// app/build/thumbnail/config.js), each re-encoded in its own format. Never SVG:
// sharp can only rasterise it. Without optimised coding the JPEG encoder needs
// half the memory, for a file a fraction of a percent larger.
const ENCODERS = {
  jpeg: (image) => image.jpeg({ quality: 90, optimiseCoding: false }),
  png: (image) => image.png(),
  gif: (image) => image.gif(),
  webp: (image) => image.webp({ quality: 90 }),
};

// Pixels, every frame of an animation together, so the decode and encode fit
// in the job's cgroup (cgroupLimits in jail.js). The worst cases are a
// progressive JPEG, whose decoder holds every coefficient, and WebP, whose
// decoder and encoder both hold the whole image. A 24 MP camera's photo fits.
const MAX_PIXELS = {
  jpeg: 24 * 1000 * 1000,
  png: 24 * 1000 * 1000,
  gif: 24 * 1000 * 1000,
  webp: 16 * 1000 * 1000,
};

// The response headers helper/transformer/download caches on
const CACHE_HEADERS = {
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

// As node-fetch sent them, which the transformer used before this job
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
function checkHeader(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_HEADER_LENGTH || !/^[\x20-\x7e]*$/.test(value)) {
    throw new FetchError("invalid conditional header");
  }
  return value;
}

function remaining(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new FetchError("timed out");
  return ms;
}

// One request, resolving with the response once its headers are in
function request(url, headers, deadline) {
  const wait = Math.min(HEADERS_TIMEOUT, remaining(deadline));
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers, agent: false }, resolve);
    const timer = setTimeout(() => req.destroy(new FetchError("timed out")), wait);
    req.on("response", () => clearTimeout(timer));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// The body, with its content encoding undone, within the limits
function readBody(res, deadline) {
  const left = deadline - Date.now();
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers["content-encoding"] || "identity").trim().toLowerCase();
    if (encoding !== "identity" && !DECODERS[encoding]) {
      res.destroy();
      return reject(new FetchError("unsupported content encoding"));
    }

    const declared = Number(res.headers["content-length"]);
    const expected = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    if (expected !== null && expected > MAX_BODY_BYTES) {
      res.destroy();
      return reject(new FetchError("image is too large"));
    }

    const decoder = encoding === "identity" ? null : DECODERS[encoding]();
    const output = decoder || res;
    const chunks = [];
    let received = 0;
    let decoded = 0;
    let settled = false;
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
      resolve(Buffer.concat(chunks, decoded));
    };

    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(new FetchError("download stalled")), IDLE_TIMEOUT);
    };
    const whole = setTimeout(() => finish(new FetchError("timed out")), Math.max(0, left));

    res.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) return finish(new FetchError("image is too large"));
      armIdle();
    });
    res.on("aborted", () => finish(new FetchError("download was cut short")));
    res.on("error", () => finish(new FetchError("download was cut short")));

    output.on("data", (chunk) => {
      decoded += chunk.length;
      if (decoded > MAX_DECODED_BYTES) return finish(new FetchError("image is too large"));
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

function cacheHeaders(res) {
  const headers = {};
  for (const [name, header] of Object.entries(CACHE_HEADERS)) {
    const value = res.headers[header];
    if (typeof value === "string" && value) headers[name] = value.slice(0, MAX_HEADER_LENGTH);
  }
  return headers;
}

// Follows up to MAX_REDIRECTS redirects, each to an http(s) URL with no
// credentials. Resolves with the final response and its body, or a 304.
async function fetchURL(url, conditional) {
  const deadline = Date.now() + DEADLINE;
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br",
  };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

  for (let redirects = 0; ; redirects++) {
    const res = await request(url, headers, deadline);
    const status = res.statusCode;

    if (status >= 300 && status < 400 && status !== 304 && res.headers.location) {
      res.resume();
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
      res.resume();
      return { status, headers: cacheHeaders(res) };
    }

    if (status < 200 || status > 299) {
      res.resume();
      throw new FetchError(String(status), { status });
    }

    return { status, headers: cacheHeaders(res), body: await readBody(res, deadline) };
  }
}

// Decodes the body, which must be an image in one of ENCODERS' formats, and
// encodes it again: what comes out was written by libvips, not the server.
async function reencode(body) {
  let info;
  try {
    info = await sharp(body).metadata();
  } catch (e) {
    throw new FetchError("not an image");
  }

  const encoder = ENCODERS[info.format];
  if (!encoder) throw new FetchError("not a supported image format");

  const pages = info.pages || 1;
  const height = info.pageHeight || info.height;
  const limit = MAX_PIXELS[info.format];
  if (!info.width || !height || info.width * height * pages > limit) {
    throw new FetchError("image is too large");
  }

  // Applying the EXIF orientation keeps a photo the right way up once the
  // re-encode has dropped its EXIF. An animation has none.
  let image = sharp(body, { animated: pages > 1, limitInputPixels: limit }).keepIccProfile();
  if (pages === 1) image = image.rotate();

  let output;
  try {
    output = await encoder(image).toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw new FetchError("image could not be decoded");
  }
  if (output.data.length > MAX_OUTPUT_BYTES) throw new FetchError("image is too large");

  return {
    data: output.data,
    format: output.info.format,
    width: output.info.width,
    height: output.info.pageHeight || output.info.height,
  };
}

function failure(err) {
  const meta = { error: String(err.message || "fetch failed").slice(0, 200) };
  if (err.status) meta.status = err.status;
  if (typeof err.code === "string") meta.code = err.code.slice(0, 40);
  return { meta, outputs: [] };
}

async function run(args) {
  try {
    if (!args || typeof args !== "object") throw new FetchError("URL is not allowed");
    const url = checkURL(args.url);
    const conditional = {
      etag: checkHeader(args.etag),
      lastModified: checkHeader(args.lastModified),
    };

    const response = await fetchURL(url, conditional);
    if (response.status === 304) {
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
    // The URL's doing: a FetchError, or a network or TLS error, which has a
    // code. Anything else is a bug, and fails the job.
    if (err instanceof FetchError || typeof err.code === "string") return failure(err);
    throw err;
  }
}

module.exports = { run, MAX_REDIRECTS, MAX_BODY_BYTES, MAX_DECODED_BYTES, MAX_PIXELS };
