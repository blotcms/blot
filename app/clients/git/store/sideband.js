// Streams the answer to a push to the client as the push works, instead of
// all at once at the end, so a slow push does not look frozen.
//
//   const response = createResponse(res, { capabilities, commands });
//   receive({ ..., progress: response.progress })
//     .then(response.finish, response.fail);
//
// With side-band-64k the client prints what arrives on band 2 as "remote:"
// lines, so each progress message is written (and flushed by the socket) as it
// happens. The report-status goes last on band 1, then the flush packet. A
// client that sent `quiet` gets no progress, and one that did not negotiate
// side-band-64k gets only the plain report, as git sends it.
//
// A stage which is silent for a while gets an empty band 1 packet ("0005\x01"),
// which is what git's own receive-pack sends to keep proxies and clients from
// timing out. The client reads it as a report fragment of no length.
//
// Once the first byte is out the HTTP status can no longer change, so every way
// of ending is a report: finish() reports what receive() resolved with, and
// fail() reports every ref as failed. Nothing here can end the response without
// one of them, and the response is never "ok" unless receive() said so.
const MAX_PACKET = 65520;
const KEEPALIVE = Buffer.from("0005\x01");

function pktLine(content) {
  return Buffer.concat([Buffer.from((4 + content.length).toString(16).padStart(4, "0")), content]);
}

function oneLine(text) {
  return String(text).replace(/[\r\n\0]+/g, " ").trim().slice(0, 1000);
}

function createResponse(res, { capabilities = "", commands = [], keepaliveMs = 5000 } = {}) {
  const wanted = Array.isArray(capabilities) ? capabilities : String(capabilities).split(/\s+/);
  const has = (name) => wanted.includes(name);
  const sideband = has("side-band-64k");
  const quiet = has("quiet");
  const stats = { keepalives: 0, progress: 0 };
  let timer = null;
  let ended = false;

  function write(buffer) {
    if (ended || res.destroyed) return;
    if (!res.headersSent) {
      res.setHeader("content-type", "application/x-git-receive-pack-result");
      res.setHeader("cache-control", "no-cache, max-age=0, must-revalidate");
      res.setHeader("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
      res.writeHead(200);
    }
    res.write(buffer);
  }

  function band(number, content) {
    for (let at = 0; at < content.length || at === 0; at += MAX_PACKET - 5) {
      write(pktLine(Buffer.concat([Buffer.from([number]), content.subarray(at, at + MAX_PACKET - 5)])));
    }
  }

  // After every write, the clock for the next keepalive starts again
  function touch() {
    clearTimeout(timer);
    if (!sideband || ended || !(keepaliveMs > 0)) return;
    timer = setTimeout(() => {
      stats.keepalives++;
      write(KEEPALIVE);
      touch();
    }, keepaliveMs);
    timer.unref();
  }

  function progress(message) {
    if (!sideband || quiet || ended) return;
    stats.progress++;
    band(2, Buffer.from(oneLine(message) + "\n"));
    touch();
  }

  function end(status, results, messages) {
    if (ended) return;
    clearTimeout(timer);

    if (sideband) for (const message of messages) band(2, Buffer.from(oneLine(message) + "\n"));

    if (has("report-status")) {
      const lines = [pktLine(Buffer.from("unpack " + oneLine(status) + "\n"))];
      for (const { ref, error } of results) {
        lines.push(pktLine(Buffer.from(error ? "ng " + ref + " " + oneLine(error) + "\n" : "ok " + ref + "\n")));
      }
      lines.push(Buffer.from("0000"));
      const report = Buffer.concat(lines);

      if (sideband) band(1, report);
      else write(report);
    }

    if (sideband) write(Buffer.from("0000"));
    if (!res.headersSent) write(Buffer.alloc(0));
    ended = true;
    res.end();
  }

  // receive()'s result, as the end of the response
  function finish(result) {
    end(result.status, result.results, result.messages);
  }

  // Something other than a result: every ref failed, whatever was said before
  function fail(err) {
    console.error("Git store: receive failed", err);
    end(
      "Blot hit an error receiving the push; please try again in a moment",
      commands.map(({ ref }) => ({ ref, error: "internal error" })),
      ["Blot hit an error receiving the push. Run git fetch to see whether it was saved before you push again."]
    );
  }

  return { progress, finish, fail, stats };
}

module.exports = createResponse;
