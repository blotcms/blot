// Test-only reads from the store, and timing for the same reads on EBS, so the
// two can be compared on real traffic before cutover (#2259). See README.
//
//   handle(req, res, blog)         serves the read side of git's smart HTTP
//                                  from the store, for a blog in shadow mode
//   timeEbs(req, res, blogID)      times the read side served from EBS
//                                  (smartHttp.js), and logs it
//
// handle() is what routes.js runs for /clients/git/store-end/<handle>.git
// after the same authentication as /clients/git/end/. It only reads: it never
// writes to the store or to the bare repository, and a push is refused with a
// message. Its only write is the cache's, on local disk, which is what the
// store's own clones use.
//
// Each request logs one line, in shadow mode's format (see index.js):
//
//   [git-store-shadow] blog=<id> op=advertise|clone|fetch source=store|ebs
//     outcome=... storeMs|ebsMs=... firstByteMs=... [requests=... bytesDown=...]
//     bytesSent=... [deepen=... shallow=1 filter=...]
//
// The last three are on source=ebs lines only, and only when the client's
// upload-pack request asked for them: what the store does not serve, so how
// often real clients need it (#2259). deepen is the kind of the depth request,
// deepen|deepen-since|deepen-not ("+"-separated if more than one, so the logger leaves it unquoted; the
// value is never logged), shallow=1 is set if the client sent shallow lines
// (it has a shallow clone), and filter is the partial-clone spec, e.g.
// blob:none or tree:0 (other characters make it "other").
//
// op: advertise is GET info/refs; a POST is a fetch if the client sent have
// lines (the way clone.js's serve() tells them apart) and a clone if not.
// Blog IDs only: never handles.
const zlib = require("zlib");
const receivePack = require("../receivePack");
const served = require("../served/reads");
const { createLimiter } = require("../store/clone");

const { meter, outcomeOf, whenDone, reply } = served;

const MAX_INSPECT = 64 * 1024;

// Reads from the store for the test route, at most this many at once and this
// many waiting, so it cannot crowd out what the unit is for
const limiter = createLimiter({ max: 2, maxWaiting: 4 });

function log(fields) {
  require("./index")._log(fields);
}

// The refusal of a push, which git shows as "fatal: remote error: ..."
const PUSH_REFUSED = "pushes go to the normal URL";

function refusePushAdvertisement(res) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-git-receive-pack-advertisement");
  receivePack.noCache(res);
  res.end(
    Buffer.concat([
      receivePack.pktLine("# service=git-receive-pack\n"),
      Buffer.from("0000"),
      receivePack.pktLine("ERR " + PUSH_REFUSED + "\n"),
    ])
  );
}

// Serves the request from the store. The request is authenticated, req.url is
// "/<handle>.git/..." and req.gitHandle the handle; blog is the blog it names.
// Anything but a blog in shadow mode on git gets a 404, as if there were no
// such route. Never rejects.
async function handle(req, res, blog) {
  const hook = require("./hook");

  res.setHeader("connection", "close");

  if (!hook.enabled(blog.id) || blog.client !== "git") return reply(res, 404, "not found");

  const url = req.url;
  const query = url.indexOf("?");
  const pathname = query === -1 ? url : url.slice(0, query);
  const repository = "/" + req.gitHandle + ".git";
  const service = require("querystring").parse(query === -1 ? "" : url.slice(query + 1)).service;

  if (req.method === "GET" && pathname === repository + "/info/refs") {
    if (service === "git-receive-pack" || service === "receive-pack") return refusePushAdvertisement(res);
    if (service !== "git-upload-pack" && service !== "upload-pack") return reply(res, service ? 405 : 400, service ? "service not available" : "service parameter required");
    return read(req, res, blog, "advertise");
  }

  if (req.method === "POST" && url === repository + "/git-receive-pack") return reply(res, 403, PUSH_REFUSED);
  if (req.method === "POST" && url === repository + "/git-upload-pack") return read(req, res, blog, "post");
  if (req.method !== "GET" && req.method !== "POST") return reply(res, 405, "method not supported");

  reply(res, 404, "not found");
}

// The store's side, through the served path's read (../served/reads.js) with
// this route's own limiter, logged in shadow mode's format
async function read(req, res, blog, kind) {
  let ctx;

  try {
    ctx = require("./index").readContext(blog.id);
  } catch (err) {
    log({ blog: blog.id, op: kind === "post" ? "clone" : kind, source: "store", outcome: "error", detail: (err && (err.code || err.name)) || "error" });
    return reply(res, 500, "the store could not serve this");
  }

  const fields = await served.read(req, res, { kind, store: ctx.store, cache: ctx.cache, limiter });

  log({
    blog: blog.id,
    op: fields.op,
    source: "store",
    outcome: fields.outcome,
    storeMs: fields.ms,
    firstByteMs: fields.firstByteMs,
    requests: fields.requests,
    bytesDown: fields.bytesDown,
    bytesSent: fields.bytesSent,
    detail: fields.detail,
  });
}

// ---- EBS ------------------------------------------------------------------

// Whether a request body (the first part of it, decompressed) has have lines
function hasHaves(buffer) {
  return /[0-9a-f]{4}have [0-9a-f]{40}/.test(buffer.toString("latin1"));
}

// What the start of an upload-pack request (v0, decompressed) asks for beyond
// plain wants and haves: { deepen, shallow, filter }, each undefined if absent.
// Reads the pkt-lines up to the first flush, where wants, shallows, deepens and
// the filter end, and stops at anything which is not a pkt-line.
function shape(buffer) {
  const text = buffer.toString("latin1");
  const kinds = [];
  let shallow = false;
  let filter;
  let offset = 0;

  while (offset + 4 <= text.length) {
    const head = text.slice(offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;

    const length = parseInt(head, 16);
    if (length === 0) break;
    if (length < 4) break;

    const line = text.slice(offset + 4, offset + length).replace(/\n$/, "");
    offset += length;

    if (line.startsWith("shallow ")) shallow = true;
    else if (/^deepen(?:-since|-not)? /.test(line)) {
      const kind = line.split(" ")[0];
      if (kinds.indexOf(kind) === -1) kinds.push(kind);
    } else if (line.startsWith("filter ") && filter === undefined) {
      const spec = line.slice("filter ".length);
      filter = /^[\w:=.+-]{1,64}$/.test(spec) ? spec : "other";
    }
  }

  return {
    deepen: kinds.length ? kinds.join("+") : undefined,
    shallow: shallow ? 1 : undefined,
    filter,
  };
}

// Times the read side of the EBS route (smartHttp.js serving a clone or fetch
// with `git upload-pack`) and logs it with source=ebs. It only watches: the
// request and response are not changed, other than the response's write being
// counted. Call it before the request is handled.
function timeEbs(req, res, blogID) {
  try {
    const started = Date.now();
    const isAdvertisement = req.method === "GET" && /\/info\/refs\?(?:.*&)?service=git-upload-pack(?:&|$)/.test(req.url);
    const isUpload = req.method === "POST" && /\/git-upload-pack$/.test(req.url);

    if (!isAdvertisement && !isUpload) return;

    // The service line is written before git is asked anything: the first
    // byte is the first of git's own
    const sent = meter(res, started, isAdvertisement ? 1 : 0);
    let op = isAdvertisement ? "advertise" : "clone";
    let asked = {};

    if (isUpload) {
      // A copy of the start of the body, to see whether the client sent haves
      let inspected = 0;
      const pieces = [];
      const gzipped = req.headers["content-encoding"] === "gzip";

      function inspect(chunk) {
        if (inspected >= MAX_INSPECT) return;
        inspected += chunk.length;
        pieces.push(chunk);
      }

      // Watches the body only once smartHttp.js pipes it into upload-pack. A
      // data listener added now would start the body flowing while the
      // request waits for a place in the git limiter, and git would get none
      // of what flowed past. Added after the pipe, it follows the pipe's pace.
      const pipe = req.pipe;
      req.pipe = function () {
        req.pipe = pipe;
        const destination = pipe.apply(req, arguments);
        req.on("data", inspect);
        return destination;
      };

      whenDone(res, function () {
        try {
          let body = Buffer.concat(pieces);
          // A body cut short at MAX_INSPECT still opens as far as it goes
          if (gzipped) body = zlib.gunzipSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
          if (hasHaves(body)) op = "fetch";
          asked = shape(body);
        } catch (err) {
          // Not a body to tell by: it stays a clone
        }
      });
    }

    whenDone(res, function () {
      log({
        blog: blogID,
        op,
        source: "ebs",
        outcome: outcomeOf(res),
        ebsMs: Date.now() - started,
        firstByteMs: sent.firstByteMs === null ? undefined : sent.firstByteMs,
        bytesSent: sent.bytes,
        deepen: asked.deepen,
        shallow: asked.shallow,
        filter: asked.filter,
      });
    });
  } catch (err) {
    // Timing must never touch the request
  }
}

module.exports = { handle, timeEbs, PUSH_REFUSED };
