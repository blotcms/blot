// A push to a blog's repository in the git store (#2259): the store's receive
// (../store/receive.js), with what Blot does around a push.
//
//   handle(req, res, blog, hooks)   hooks are repo.js's receiveHooks: lock,
//                                   prepare, abandoned, accepted
//
// A push is applied whole or not at all: if any ref is refused or stale, none
// is updated. Blot syncs master; tags are kept but do nothing; there are no
// other branches, or other kinds of ref.
//
// 1. The commands are read and parsed by receivePack.js, which also has the
//    capabilities advertised; git's 0000 probe is answered, and each push
//    logs a push-client line with the client's agent.
// 2. The store's receive takes the push, with the interactive lane as its
//    gate, progress on side-band (store/sideband.js: "Saving to Blot..." and
//    the keepalives), the Content-Length as its size hint, Blot's tree rule
//    (regular files only on master) and the limit below.
// 3. The follow-up sync is armed before the swap. The lock(fn) the store
//    takes around its manifest swap holds the blog's ref lock and, the first
//    time, arms the follow-up (hooks.prepare) when master changes; a swap
//    tried again after another writer won uses the same alarm. If the push
//    then does not land the alarm is cancelled (hooks.abandoned). So a push
//    the client is told succeeded is never lost to a crash.
// 4. ok: the sync starts (hooks.accepted) and a compaction is asked for
//    (./upkeep.js). refused or failed: reported to the client. unknown:
//    reported as neither (the store tells the user to fetch before pushing
//    again), and the alarm is kept, so a sync then applies whatever master
//    is.
//
// One line per push:
//
//   [git-store-served] blog=<id> op=push outcome=ok|refused|failed|unknown|...
//     ms=... bytesUp=... objects=... basesFetched=...
const zlib = require("zlib");
const { execFile } = require("child_process");
const clfdate = require("helper/clfdate");
const receivePack = require("../receivePack");
const limiter = require("../limiter");
const receive = require("../store/receive");
const createResponse = require("../store/sideband");
const context = require("./context");
const upkeep = require("./upkeep");
const log = require("./log");

const MASTER = "refs/heads/master";

// The share of the cache's budget a push to the store may be. A push is
// streamed into scratch space reserved from the cache, and is completed and
// indexed there, so a push needs about its own size again on top; half the
// budget leaves room for the clones and fetches the cache serves meanwhile.
// With the default 1 GiB cache that is 512 MiB. The limit is the smaller of
// this and receive.maxInputSize, git's limit in the Docker image (agreed with
// the operator, 3 Nov 2026: no larger cache for this).
const PUSH_CACHE_SHARE = 0.5;

// receive.maxInputSize, from git's config (the Docker image sets it for every
// git process), read once per process. 0 when it is not set.
let maxInputSize = null;

function readMaxInputSize() {
  if (!maxInputSize) {
    maxInputSize = limiter.run("interactive", function () {
      return new Promise(function (resolve) {
        execFile("git", ["config", "--get", "receive.maxInputSize"], { timeout: 30 * 1000 }, function (err, stdout) {
          resolve(err ? 0 : receivePack.parseSize(String(stdout).trim()));
        });
      });
    });
  }

  return maxInputSize;
}

// The most bytes of pack a push to the store may carry
async function pushLimit(cache) {
  const share = Math.floor(cache.maxBytes * PUSH_CACHE_SHARE);
  const configured = await readMaxInputSize();

  return configured > 0 ? Math.min(configured, share) : share;
}

// The request's body, decompressed if it was sent gzipped
function bodyOf(req) {
  if (req.headers["content-encoding"] !== "gzip") return req;

  const gunzip = zlib.createGunzip();
  req.pipe(gunzip);

  // A client which goes away part way through ends the request with an error
  // or an abort, which piping does not pass on: without this the receive
  // would wait on the decoder for ever, holding its cache reservation
  req.on("error", function (err) {
    gunzip.destroy(err);
  });
  req.on("aborted", function () {
    gunzip.destroy(new Error("aborted"));
  });

  return gunzip;
}

function isBadRequest(err) {
  return !!(err && (err.badRequest || (typeof err.code === "string" && /^Z_/.test(err.code))));
}

async function handle(req, res, blog, hooks) {
  const started = Date.now();
  const fields = { blog: blog.id, op: "push" };

  res.setHeader("connection", "close");
  res.on("error", function () {});
  req.on("error", function () {});

  try {
    await push(req, res, blog, hooks, fields);
  } catch (err) {
    fields.outcome = isBadRequest(err) ? "http400" : "error";
    fields.detail = (err && (err.code || err.name)) || "error";

    if (!res.headersSent) {
      res.statusCode = isBadRequest(err) ? 400 : 500;
      res.setHeader("content-type", "text/plain");
      res.end(isBadRequest(err) ? "bad request body" : "");
    } else if (!res.writableEnded) {
      res.destroy();
    }

    if (!isBadRequest(err)) console.error(clfdate(), "[git-store-served] blog=" + blog.id, "push failed:", err && err.message);
  } finally {
    fields.ms = Date.now() - started;
    log(fields);
  }
}

async function push(req, res, blog, hooks, fields) {
  const blogID = blog.id;
  const body = bodyOf(req);
  const iterator = body[Symbol.asyncIterator]();
  const packets = await receivePack.readPackets(iterator);
  const parsed = receivePack.parseCommands(packets.lines);
  const commands = parsed.commands;
  const capabilities = parsed.capabilities;

  // Git's 0000 probe, sent before a request larger than http.postBuffer
  if (!commands.length) {
    for (;;) if ((await iterator.next()).done) break;
    res.setHeader("content-type", "application/x-git-receive-pack-result");
    receivePack.noCache(res);
    fields.outcome = "probe";
    return res.end();
  }

  const agent = receivePack.capability(capabilities, "agent");

  console.log(
    clfdate(),
    req.headers["x-request-id"] || "no-request-id",
    "Git: push-client",
    req.gitHandle,
    "agent=" + JSON.stringify(typeof agent === "string" ? agent.slice(0, 100) : "")
  );

  const store = context.storeFor(blogID);
  const cache = context.cache();
  const limit = await pushLimit(cache);
  const master = commands.find((command) => command.ref === MASTER && command.old !== command.new) || null;
  const length = Number(req.headers["content-length"]);
  const sizeHint = req.headers["content-encoding"] !== "gzip" && length > 0 ? length : 0;

  let armed;
  let readied = false;

  // Held around the store's manifest swap: the ref lock, and the alarm armed
  // once, before master can move
  // A failure here is reported to the client in these words (pushStatus,
  // which the store's receive passes on)
  async function lock(fn) {
    let release;

    try {
      release = await hooks.lock();
    } catch (err) {
      if (err && err.code === "ELOCKED") err.pushStatus = "another change to this repository is being applied; please try again in a few seconds";
      else if (err) err.pushStatus = "Blot could not accept the push right now; please try again in a moment";
      throw err;
    }

    try {
      if (master && !readied) {
        try {
          armed = await limiter.outside(() => hooks.prepare(master));
        } catch (err) {
          console.error(clfdate(), "Git: could not record push", blogID, err && err.message);
          throw Object.assign(new Error("Could not record the push: " + ((err && err.message) || err)), {
            pushStatus: "Blot could not record the push; please try again in a moment",
          });
        }
        readied = true;
      }

      return await fn();
    } finally {
      await Promise.resolve()
        .then(release)
        .catch(function (err) {
          console.error(clfdate(), "Git: could not release the ref lock of", blogID, err && err.message);
        });
    }
  }

  async function* pack() {
    if (packets.rest.length) yield packets.rest;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  const response = createResponse(res, { capabilities, commands });
  let result;

  try {
    result = await receive({
      store,
      cache,
      lock,
      commands,
      pack: pack(),
      limit,
      sizeHint,
      progress: response.progress,
      gate: limiter.gate("interactive"),
      regularFilesOnly: true,
    });
  } catch (err) {
    // receive() does not throw; whatever did, every ref is reported failed
    result = null;
    response.fail(err);
    fields.outcome = "error";
  }

  if (result) response.finish(result);

  const stats = (result && result.stats) || {};
  fields.outcome = fields.outcome || result.outcome;
  fields.bytesUp = stats.bytes;
  fields.objects = stats.objects;
  fields.basesFetched = stats.basesFetched;
  fields.seq = result && result.seq;
  if (result && result.error) fields.detail = result.error.code || result.error.name || "error";

  if (result && result.outcome === "ok") {
    if (master) {
      try {
        // The sync this starts waits for room of its own
        limiter.outside(() => hooks.accepted(master, armed));
      } catch (err) {
        console.error(clfdate(), "Git: error after push", blogID, err);
      }
    }

    upkeep.compactAfter(blogID, result.manifest);
  }

  const outcome = result ? result.outcome : "error";

  if (outcome !== "ok" && outcome !== "unknown" && readied) {
    // Did not land: the alarm goes. An unknown outcome keeps it, so a sync
    // applies whatever master turned out to be.
    await Promise.resolve(limiter.outside(() => hooks.abandoned(master, armed))).catch(function () {});
  }
}

module.exports = { handle, pushLimit, PUSH_CACHE_SHARE };
