const sandboxFetch = require("sandbox/fetch");
const lifecycle = require("../lifecycle");

// Each import processes assets sequentially. Keep per-asset memory and total
// transferred data bounded independently of remote Content-Length headers.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

// The fetching is the sandbox's fetch job (app/sandbox/jobs/fetch.js), which
// has its own limits for a single response and decompresses it in the jail.
// What is here is the import's: its deadline, its cancellation and its total.
//
//   download(url, { kind, check, timeout, maxBytes, headers, prefetched })
//
// kind is "file" (the default; with check "pdf" or "audio"), "text" or
// "image", as the fetch job takes them. Resolves with { data, headers, format,
// width, height }: headers is a Map of the content-type and
// content-disposition the server sent, for an image its format is what the
// jail found. prefetched is the Map prefetch() returned, to take the answer
// from instead of a jail for this one URL.

const KEY = (url, kind, check) => [kind, check || "", url].join("|");

function isFetchable(url) {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch (e) {
    return false;
  }
}

// The names callers give request headers, as the fetch job takes them
function jobHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = { "user-agent": "userAgent", referer: "referer", accept: "accept" }[name.toLowerCase()];
    if (key) result[key] = value;
  }
  return result;
}

function toRequest(url, options) {
  const { kind = "file", check, timeout = 5000, maxBytes = MAX_BYTES, headers } = options;
  const request = { url, kind, timeoutMs: timeout, maxBytes: kind === "image" ? undefined : maxBytes };
  if (check) request.check = check;
  if (headers) request.headers = jobHeaders(headers);
  return request;
}

// Waits for a promise, but gives up as soon as the import is cancelled or its
// signal aborts: the jail's fetch has a time limit of its own to run out
function whileRunning(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(lifecycle.cancelled());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function currentSignal() {
  const state = lifecycle.current();
  return state && state.signal;
}

// Fetches several URLs in one jail, so an import pays for its start once for a
// post's images, or its audio, or its PDFs, not for each. Resolves with a Map
// to pass to download() as prefetched, which gives each URL's answer, error
// included. A URL the sandbox itself failed on (busy, unavailable) is
// left out of it, so download() tries it again by itself.
async function prefetch(urls, options = {}) {
  const prefetched = new Map();
  lifecycle.check();
  const wanted = [...new Set(urls)].filter(isFetchable);
  if (wanted.length < 2) return prefetched;

  const { kind = "file", check } = options;
  let results;
  try {
    results = await whileRunning(
      sandboxFetch.many(wanted.map((url) => toRequest(url, options)), { label: "import" }),
      currentSignal()
    );
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    return prefetched;
  }
  lifecycle.check();
  wanted.forEach((url, i) => {
    const sandboxFailed = !results[i].ok && /^SANDBOX_/.test(results[i].error.code || "");
    if (!sandboxFailed) prefetched.set(KEY(url, kind, check), results[i]);
  });
  return prefetched;
}

module.exports = async function download(url, options = {}) {
  const { kind = "file", check, prefetched } = options;
  lifecycle.check();
  const state = lifecycle.current();
  const signal = options.signal || (state && state.signal);

  if (!isFetchable(url)) throw new Error("Only HTTP(S) URLs can be imported: " + String(url).slice(0, 100));

  const key = KEY(url, kind, check);
  let result;
  if (prefetched && prefetched.has(key)) {
    result = prefetched.get(key);
  } else {
    result = await whileRunning(
      sandboxFetch.many([toRequest(url, options)], { label: "import" }).then((results) => results[0]),
      signal
    );
  }
  if (signal && signal.aborted) throw lifecycle.cancelled();
  if (!result.ok) throw result.error;

  const bytes = result.data.length;
  if (state) state.bytes += bytes;
  if (state && state.bytes > MAX_IMPORT_BYTES) {
    const error = new Error("Import exceeds 1 GiB download limit");
    error.code = "IMPORT_BYTE_LIMIT";
    state.abort(error);
    throw error;
  }

  const headers = new Map();
  if (result.headers.contentType) headers.set("content-type", result.headers.contentType);
  if (result.headers.contentDisposition) headers.set("content-disposition", result.headers.contentDisposition);
  return { data: result.data, headers, format: result.format, width: result.width, height: result.height };
};

module.exports.prefetch = prefetch;
module.exports.MAX_BYTES = MAX_BYTES;
