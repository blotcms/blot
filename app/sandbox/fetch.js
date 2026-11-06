// Fetches URLs the app doesn't trust (a customer's domain, a link in an imported
// post) in the sandbox's fetch job, so Node never decompresses or parses the
// bytes a remote server sent. The job, its kinds and its limits are
// ./jobs/fetch.js:
//
//   const fetch = require("sandbox/fetch");
//   const result = await fetch.one({ url, kind: "text" });      // throws
//   const results = await fetch.many([{ url, kind: "file" }]);  // never throws
//                                                               // for a URL
//
// A result is { ok: true, status, headers, kind, data } plus text for the text
// kind, format, width and height for an image, and extracted for the html kind
// (the fixed extraction the request named, run on the page in the jail, so Node
// never parses it); or { ok: false, error }.
// headers has the names of the job's NAMES (etag, contentType, location...).
// An error has the message the job gave, and status (a refused status), code (a
// network error's, such as ECONNREFUSED), type "request-timeout" for a timeout.
// Or, if the sandbox itself failed, its SANDBOX_* code.
//
// many sends up to MAX_REQUESTS to a jail at a time and sends again, in a later
// jail, the ones the job put off for want of room, so it holds every body it
// returns in memory at once: give it what the caller can hold. batch is one
// jail, with the put-off ones answered { deferred: true } for the caller to
// send again when it has room; it holds at most one jail's bodies.
//
// In production a unit without a sandbox refuses, as helper/egress used to:
// the job would run in this process, with nothing to keep it off internal
// addresses.

const config = require("config");
const sandbox = require("./index");
const { MAX_REQUESTS } = require("./jobs/fetch");

const NONE = Buffer.alloc(0);

function assertReady(label) {
  if (!config.sandbox.socket && config.egress.required) {
    throw new Error(
      `sandbox/fetch: refusing to fetch a user-controlled URL${
        label ? " (" + label + ")" : ""
      } - this unit has no sandbox (BLOT_SANDBOX). See app/sandbox/README.md.`
    );
  }
}

function failed(meta) {
  const err = new Error(meta.error || "fetch failed");
  if (meta.status) err.status = meta.status;
  if (meta.code) err.code = meta.code;
  if (meta.timedOut) {
    err.type = "request-timeout";
    err.name = "TimeoutError";
  }
  return { ok: false, error: err };
}

function succeeded(meta, output) {
  const result = {
    ok: true,
    status: meta.status,
    headers: meta.headers || {},
    kind: meta.kind,
    data: output,
  };
  if (meta.kind === "text") result.text = output.toString("utf8");
  if (meta.kind === "image") {
    Object.assign(result, {
      format: meta.format,
      width: meta.width,
      height: meta.height,
    });
  }
  // A named extraction's data from the jail's parse of a page (kind "html")
  if (meta.kind === "html") result.extracted = meta.extracted || {};
  if (meta.truncated) result.truncated = true;
  return result;
}

// One jail's worth. Resolves with the result of each request, or { deferred }
// for one the job put off for want of room, which the caller sends again.
async function batch(requests, { label } = {}) {
  assertReady(label);
  let reply;
  try {
    reply = await sandbox.run("fetch", { requests }, NONE);
  } catch (err) {
    return requests.map(() => ({ ok: false, error: err }));
  }

  const { meta, outputs } = reply;
  if (!meta || typeof meta !== "object")
    return requests.map(() => failed({ error: "fetch: no answer" }));
  if (meta.error) return requests.map(() => failed(meta));
  if (!Array.isArray(meta.results) || meta.results.length !== requests.length) {
    return requests.map(() => failed({ error: "fetch: invalid answer" }));
  }

  return meta.results.map((result, i) => {
    if (!result || typeof result !== "object")
      return failed({ error: "fetch: invalid answer" });
    if (result.deferred) return { deferred: true };
    return result.error
      ? failed(result)
      : succeeded(result, outputs[i] || NONE);
  });
}

// options: { label, signal }. Once signal aborts no further jail is started,
// and many rejects with its reason.
async function many(requests, { label, signal } = {}) {
  assertReady(label);
  if (!Array.isArray(requests))
    throw new Error("sandbox/fetch: requests must be a list");

  const results = new Array(requests.length);
  let pending = requests.map((request, i) => i);

  while (pending.length) {
    if (signal && signal.aborted)
      throw signal.reason || new Error("sandbox/fetch: aborted");
    const indexes = pending.slice(0, MAX_REQUESTS);
    pending = pending.slice(MAX_REQUESTS);
    const answers = await batch(
      indexes.map((i) => requests[i]),
      { label }
    );

    let progress = false;
    answers.forEach((answer, j) => {
      if (answer.deferred) pending.push(indexes[j]);
      else {
        results[indexes[j]] = answer;
        progress = true;
      }
    });

    // The job never puts off a request with a batch to itself, so this is a
    // broken job, not a reason to ask again
    if (!progress) {
      for (const i of indexes)
        results[i] = failed({ error: "fetch: no progress" });
      pending = pending.filter((i) => !indexes.includes(i));
    }
  }

  return results;
}

async function one(request, options) {
  const [result] = await many([request], options);
  if (!result.ok) throw result.error;
  return result;
}

module.exports = { one, many, batch, MAX_REQUESTS };
