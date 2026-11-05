// The read side of git's smart HTTP for a blog's repository in the git store
// (#2259): the ref advertisements, clones and fetches, and the dumb HTTP HEAD
// probe, all from the store's manifest and packs, on the route
// /clients/git/end/<handle>.git with its authentication and handle redirect
// (routes.js). repo.handleSmartHttp hands requests here.
//
//   handle(req, res, blog, { receive })   answers the request; a push
//                                         (POST git-receive-pack) goes to
//                                         receive(req, res, blog)
//   read(req, res, options)               one advertisement, clone or fetch
//                                         from the store
//
// A clone or fetch takes a place in the git limiter's interactive lane, so
// the cap on concurrent clones is BLOT_GIT_INTERACTIVE_PROCESSES; the store's
// streaming keeps the memory of each bounded whatever the repository's size.
// The statuses for wrong methods and unknown paths are the ones Blot's git
// server has always given. Protocol v0 only, with no shallow clones or
// filters: the store answers those with an ERR packet, which git shows as
// "remote error". A store with no copy of the repository answers 503, never
// an empty repository.
//
// Each request logs one line (./log.js):
//
//   [git-store-served] blog=<id> op=advertise|clone|fetch|receive-advertise|head
//     outcome=... ms=... firstByteMs=... requests=... bytesDown=... bytesSent=...
//     [reason=shallow|filter|other, for outcome=refused]
const zlib = require("zlib");
const querystring = require("querystring");
const receivePack = require("../receivePack");
const limiter = require("../limiter");
const { measure } = require("./counting");
const { advertise, CONTENT_TYPE: ADVERTISEMENT } = require("../store/advertise");
const { serve, parseRequest, CONTENT_TYPE: RESULT } = require("../store/clone");
const manifest = require("../store/manifest");
const pktline = require("../store/pktline");
const context = require("./context");
const log = require("./log");

const ZERO = "0".repeat(40);

// The request is a few lines of wants and haves. Past this it is not one.
const MAX_BODY = 1024 * 1024;

// What a client is told when the store has no copy of the repository yet
const NO_COPY = "the store has no copy of this repository yet";

// The interactive lane of the git limiter, as the store's clone limiter: each
// clone or fetch holds one place while it plans and streams
const interactive = {
  acquire: function () {
    return limiter.acquire("interactive");
  },
};

// ---- What went to the client ------------------------------------------------

// Counts what a response sends and when the first byte went, by wrapping the
// response's write and end. `skip` is how many writes to leave out of the first
// byte's time (the smart HTTP advertisement is preceded by a service line which
// is written before git has been asked anything).
function meter(res, started, skip) {
  const sent = { bytes: 0, firstByteMs: null, writes: 0 };
  const write = res.write;
  const end = res.end;

  function note(chunk) {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return;
    sent.bytes += Buffer.byteLength(chunk);
    if (sent.firstByteMs === null && sent.writes++ >= skip) sent.firstByteMs = Date.now() - started;
  }

  res.write = function (chunk) {
    note(chunk);
    return write.apply(this, arguments);
  };

  res.end = function (chunk) {
    note(chunk);
    return end.apply(this, arguments);
  };

  return sent;
}

// How a response ended: ok, aborted (the client left) or the status it sent
function outcomeOf(res) {
  if (res.statusCode >= 400) return "http" + res.statusCode;
  return res.writableFinished ? "ok" : "aborted";
}

function whenDone(res, callback) {
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    callback();
  }

  res.once("close", finish);
  res.once("finish", function () {
    setImmediate(finish);
  });
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain");
  res.end(body);
}

async function collect(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function statusOf(err) {
  return err && err.code === "BUSY" ? 503 : err && err.code === "PROTOCOL" ? 400 : 500;
}

// ---- The store ------------------------------------------------------------

// The receive-pack advertisement, from the manifest: the refs, sorted as git
// sorts them, with the capabilities in receivePack.js, as git advertises
// them. Receive-pack advertises no HEAD and no peeled tags.
function receiveAdvertisement(current) {
  const capabilities = receivePack.CAPABILITIES.join(" ");
  const names = Object.keys(current.refs).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const parts = [receivePack.pktLine("# service=git-receive-pack\n"), Buffer.from("0000")];

  if (!names.length) parts.push(receivePack.pktLine(ZERO + " capabilities^{}\0" + capabilities + "\n"));

  names.forEach(function (name, index) {
    parts.push(receivePack.pktLine(current.refs[name] + " " + name + (index === 0 ? "\0" + capabilities : "") + "\n"));
  });

  parts.push(Buffer.from("0000"));

  return Buffer.concat(parts);
}

// Answers one read from the store: kind is "advertise" (upload-pack's
// advertisement), "receive-advertise", "head" or "post" (a clone or fetch).
// options: store and cache (the blog's, from ./context.js), and limiter, the
// store's clone limiter (the interactive lane unless given). Resolves, once
// the response has finished, with the fields for its log line: op, outcome,
// ms, firstByteMs, requests, bytesDown, bytesSent, detail. Never rejects.
async function read(req, res, { kind, store, cache, limiter: clones = interactive }) {
  const started = Date.now();
  const sent = meter(res, started, 0);
  let op = kind === "post" ? "clone" : kind;
  let outcome;
  let detail;
  let reason;
  let measured = { ms: 0, counts: { requests: 0, bytesDown: 0 } };

  res.on("error", function () {});

  try {
    measured = await measure(async function () {
      const current = await manifest.read(store);

      // Nothing there: a clone of nothing would look like an empty repository
      if (manifest.isEmpty(current)) {
        reply(res, 503, NO_COPY);
        return "empty";
      }

      if (kind === "advertise") {
        res.setHeader("content-type", ADVERTISEMENT);
        receivePack.noCache(res);
        res.end(advertise(current));
        return "ok";
      }

      if (kind === "receive-advertise") {
        res.setHeader("content-type", "application/x-git-receive-pack-advertisement");
        receivePack.noCache(res);
        res.end(receiveAdvertisement(current));
        return "ok";
      }

      if (kind === "head") {
        res.setHeader("content-type", "text/plain");
        res.end("ref: " + (current.head || "refs/heads/master") + "\n");
        return "ok";
      }

      let body = await collect(req);
      if (body === null) {
        reply(res, 413, "request too large");
        return "http413";
      }

      if (req.headers["content-encoding"] === "gzip") {
        try {
          body = zlib.gunzipSync(body, { maxOutputLength: MAX_BODY * 4 });
        } catch (err) {
          reply(res, 400, "bad request body");
          return "http400";
        }
      }

      try {
        op = parseRequest(body).haves.length ? "fetch" : "clone";
      } catch (err) {
        // serve() reports what is wrong with it
      }

      res.setHeader("content-type", RESULT);
      receivePack.noCache(res);

      const result = await serve({ store, cache, manifest: current, body, out: res, limiter: clones });

      if (result.refused) reason = refusalReason(body);

      return result.refused ? "refused" : result.negotiated ? "negotiated" : result.empty ? "empty" : "ok";
    });

    outcome = measured.result;
  } catch (err) {
    outcome = err && err.code === "BUSY" ? "busy" : "error";
    detail = (err && (err.code || err.name)) || "error";

    if (!res.headersSent) {
      reply(res, statusOf(err), err && err.code === "BUSY" ? "busy, try again" : "the store could not serve this");
    } else if (!res.writableEnded) {
      res.destroy();
    }
  }

  await new Promise(function (resolve) {
    if (res.writableFinished || res.destroyed) return resolve();
    whenDone(res, resolve);
  });

  return {
    op,
    outcome: outcome === "ok" ? outcomeOf(res) : outcome,
    ms: Date.now() - started,
    firstByteMs: sent.firstByteMs === null ? undefined : sent.firstByteMs,
    requests: measured.counts ? measured.counts.requests : undefined,
    bytesDown: measured.counts ? measured.counts.bytesDown : undefined,
    bytesSent: sent.bytes,
    reason,
    detail,
  };
}

// Why the store refused a clone or fetch, for its log line, so the demand for
// what it does not serve stays visible: "shallow" (shallow, deepen,
// deepen-since or deepen-not lines), "filter" (a partial clone), or "other"
// (a want that is not a tip, a client without ofs-delta)
function refusalReason(body) {
  let filter = false;

  try {
    for (const packet of pktline.split(body)) {
      if (packet.flush) continue;
      const line = packet.data.toString("latin1");
      if (/^(shallow|deepen(-since|-not)?)( |$)/.test(line)) return "shallow";
      if (/^filter( |$)/.test(line)) filter = true;
    }
  } catch (err) {
    // Not pkt-lines to the end: what was read decides
  }

  return filter ? "filter" : "other";
}

// ---- The route ------------------------------------------------------------

// Answers a smart HTTP request for a blog's repository in the store: the
// request is authenticated, and req.gitHandle is the handle routes.js parsed.
// options.receive(req, res, blog) answers a push. Never rejects.
async function handle(req, res, blog, options) {
  const url = req.url;
  const query = url.indexOf("?");
  const pathname = query === -1 ? url : url.slice(0, query);
  const repository = "/" + req.gitHandle + ".git";
  let kind = null;

  res.setHeader("connection", "close");

  if (!req.gitHandle) return reply(res, 404, "not found");

  // A blog off the git client has no repository
  if (blog.client !== undefined && blog.client !== "git") return reply(res, 404, "repository not found");

  if (req.method === "GET" && pathname === repository + "/info/refs") {
    let service = querystring.parse(query === -1 ? "" : url.slice(query + 1)).service;

    if (!service || typeof service !== "string") return reply(res, 400, "service parameter required");

    service = service.replace(/^git-/, "");

    if (service === "upload-pack") kind = "advertise";
    else if (service === "receive-pack") kind = "receive-advertise";
    else return reply(res, 405, "service not available");
  } else if (req.method === "GET" && pathname === repository + "/HEAD") {
    kind = "head";
  } else if (req.method === "POST" && url === repository + "/git-upload-pack") {
    kind = "post";
  } else if (req.method === "POST" && url === repository + "/git-receive-pack") {
    return options.receive(req, res, blog);
  } else if (req.method === "POST" && url.indexOf(repository + "/git-") === 0 && url.length > repository.length + 5) {
    return reply(res, 405, "service not available");
  } else if (req.method !== "GET" && req.method !== "POST") {
    return reply(res, 405, "method not supported");
  } else {
    return reply(res, 404, "not found");
  }

  // A client which goes while the read waits must not leave an error nobody
  // listens for
  req.on("error", function () {});

  let store;
  let cache;

  try {
    store = context.storeFor(blog.id);
    cache = context.cache();
  } catch (err) {
    log({ blog: blog.id, op: kind === "post" ? "clone" : kind, outcome: "error", detail: (err && (err.code || err.name)) || "error" });
    return reply(res, 500, "the store could not serve this");
  }

  const fields = await read(req, res, { kind, store, cache });

  log(Object.assign({ blog: blog.id }, fields));
}

module.exports = { handle, read, receiveAdvertisement, meter, whenDone, outcomeOf, reply, refusalReason, NO_COPY };
