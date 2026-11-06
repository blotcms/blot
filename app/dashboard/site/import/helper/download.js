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
// jail found. prefetched is what prefetch() returned, to take the answer
// from instead of a jail for this one URL.

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
    const key = {
      "user-agent": "userAgent",
      referer: "referer",
      accept: "accept",
    }[name.toLowerCase()];
    if (key) result[key] = value;
  }
  return result;
}

function toRequest(url, options) {
  const {
    kind = "file",
    check,
    timeout = 5000,
    maxBytes = MAX_BYTES,
    headers,
  } = options;
  const request = {
    url,
    kind,
    timeoutMs: timeout,
    maxBytes: kind === "image" ? undefined : maxBytes,
  };
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
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Fetches a post's URLs a jail's worth at a time, so an import pays for a
// jail's start once for several images, or audio files, or PDFs, not for each.
// Nothing is fetched until download() asks for the first URL; then it and the
// URLs after it, up to a jail's batch, are fetched together, and the next batch
// only when download() reaches a URL that isn't in the last. So the answers held
// in memory are one batch's (the job keeps a batch to its first body and 16
// MiB more), and the import's byte limit, which download() checks as it takes
// each answer, stops the next batch from being fetched at all.
//
// Resolves with the object to pass to download() as prefetched. A URL the
// sandbox itself failed on (busy, unavailable) is left to download(), which
// tries it again by itself.
async function prefetch(urls, options = {}) {
  lifecycle.check();
  const pending = [...new Set(urls)].filter(isFetchable);
  const results = new Map();

  return {
    // The answer for url, or undefined to fetch it by itself
    async take(url, signal) {
      if (results.has(url)) {
        const result = results.get(url);
        results.delete(url);
        return result;
      }

      const start = pending.indexOf(url);
      if (start === -1) return undefined;
      const window = pending.slice(start, start + sandboxFetch.MAX_REQUESTS);
      if (window.length < 2) return undefined;

      // What the last batch left that wasn't asked for is dropped, not kept
      results.clear();
      if (signal && signal.aborted) throw lifecycle.cancelled();
      const answers = await sandboxFetch.batch(
        window.map((each) => toRequest(each, options)),
        { label: "import" }
      );

      window.forEach((each, i) => {
        // Put off for want of room: stays in line for a batch of its own
        if (answers[i].deferred) return;
        pending.splice(pending.indexOf(each), 1);
        const sandboxFailed =
          !answers[i].ok && /^SANDBOX_/.test(answers[i].error.code || "");
        if (!sandboxFailed) results.set(each, answers[i]);
      });

      const result = results.get(url);
      results.delete(url);
      return result;
    },
  };
}

module.exports = async function download(url, options = {}) {
  const { prefetched } = options;
  lifecycle.check();
  const state = lifecycle.current();
  const signal = options.signal || (state && state.signal);

  if (!isFetchable(url))
    throw new Error(
      "Only HTTP(S) URLs can be imported: " + String(url).slice(0, 100)
    );

  let result = prefetched
    ? await whileRunning(prefetched.take(url, signal), signal)
    : undefined;
  if (!result) {
    result = await whileRunning(
      sandboxFetch
        .many([toRequest(url, options)], { label: "import", signal })
        .then((results) => results[0]),
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
  if (result.headers.contentType)
    headers.set("content-type", result.headers.contentType);
  if (result.headers.contentDisposition)
    headers.set("content-disposition", result.headers.contentDisposition);
  return {
    data: result.data,
    headers,
    format: result.format,
    width: result.width,
    height: result.height,
  };
};

module.exports.prefetch = prefetch;
module.exports.MAX_BYTES = MAX_BYTES;
