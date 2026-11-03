// A push to a blog served from the git store (#2259).
//
// For now every push is refused, with a message, and nothing moves on either
// side: pushes to the store land in the next part of the cutover. The
// commands are read as receivePack.js reads them, the rest of the request is
// read and thrown away (a client whose request is cut off sees its connection
// reset, not the message), and each ref is reported as rejected, so git shows
// "! [remote rejected] master -> master (<message>)" and the message on a
// "remote:" line.
const zlib = require("zlib");
const clfdate = require("helper/clfdate");
const receivePack = require("../receivePack");
const log = require("./log");

const REFUSED = "Pushes to this blog are paused while Blot moves its repository. Please try again later.";

async function refuse(req, res, blog) {
  const started = Date.now();
  let source = req;
  let outcome = "refused";

  res.setHeader("connection", "close");
  res.on("error", function () {});
  req.on("error", function () {});

  if (req.headers["content-encoding"] === "gzip") {
    source = zlib.createGunzip();
    req.pipe(source);
  }

  try {
    const iterator = source[Symbol.asyncIterator]();
    const packets = await receivePack.readPackets(iterator);
    const parsed = receivePack.parseCommands(packets.lines);

    // Read to the end, so the client gets to read the answer
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
    }

    res.setHeader("content-type", "application/x-git-receive-pack-result");
    receivePack.noCache(res);

    // Git's 0000 probe, sent before a request larger than http.postBuffer
    if (!parsed.commands.length) {
      outcome = "probe";
      return res.end();
    }

    res.end(
      receivePack.formatResponse(
        parsed.capabilities,
        "ok",
        parsed.commands.map(function (command) {
          return { ref: command.ref, error: REFUSED };
        }),
        [REFUSED, "Nothing was pushed."]
      )
    );
  } catch (err) {
    const bad = !!(err && (err.badRequest || (typeof err.code === "string" && /^Z_/.test(err.code))));

    outcome = bad ? "http400" : "error";

    if (!res.headersSent) {
      res.statusCode = bad ? 400 : 500;
      res.setHeader("content-type", "text/plain");
      res.end(bad ? "bad request body" : "");
    } else if (!res.writableEnded) {
      res.destroy();
    }

    if (!bad) console.error(clfdate(), "[git-store-served] blog=" + blog.id, "could not refuse a push:", err && err.message);
  } finally {
    log({ blog: blog.id, op: "push", outcome: outcome, ms: Date.now() - started });
  }
}

module.exports = { handle: refuse, REFUSED };
