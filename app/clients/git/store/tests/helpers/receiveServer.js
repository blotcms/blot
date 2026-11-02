// A small smart-HTTP server for receive-pack, so a real `git push` can talk to
// receive(). It only speaks as much of the protocol as a push needs: the ref
// advertisement from the manifest, and the POST that carries the commands and
// the pack. Not a spec itself.
//
//   const server = await createReceiveServer({ store, cache, lock });
//   await push(dir, [server.url, "master"]);     // a real git, resolves { code, stderr }
//   server.results                               // what receive() answered, in order
//   await server.close();
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");
const manifest = require("../../manifest");
const receive = require("../../receive");

const ZERO = "0".repeat(40);
const CAPABILITIES = "report-status delete-refs side-band-64k quiet ofs-delta agent=blot";

function pkt(content) {
  const body = Buffer.from(content);
  return Buffer.concat([Buffer.from((4 + body.length).toString(16).padStart(4, "0")), body]);
}

// Reads pkt-lines up to the flush packet from an async iterator of Buffers.
// Resolves { lines, rest } where rest is what followed the flush in the chunk.
async function readCommands(iterator) {
  let buffer = Buffer.alloc(0);
  const lines = [];

  for (;;) {
    while (buffer.length >= 4) {
      const length = parseInt(buffer.toString("latin1", 0, 4), 16);
      if (length === 0) return { lines, rest: buffer.subarray(4) };
      if (buffer.length < length) break;
      lines.push(buffer.toString("utf8", 4, length).replace(/\n$/, ""));
      buffer = buffer.subarray(length);
    }
    const next = await iterator.next();
    if (next.done) throw new Error("The request ended before its commands did");
    buffer = Buffer.concat([buffer, next.value]);
  }
}

function parse(lines) {
  let capabilities = "";
  const commands = lines.map((line) => {
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const [old, next, ref] = line.split(" ");
    return { old, new: next, ref };
  });
  return { commands, capabilities };
}

// The rest of the request after the commands, as the pack receive() reads
async function* remainder(rest, iterator) {
  if (rest.length) yield rest;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

// What the client reads: messages on band 2, the report on band 1
function report(capabilities, result) {
  const band = (number, content) => pkt(Buffer.concat([Buffer.from([number]), content]));
  const lines = [pkt("unpack " + result.status + "\n")];
  for (const { ref, error } of result.results) lines.push(pkt((error ? "ng " + ref + " " + error : "ok " + ref) + "\n"));
  lines.push(Buffer.from("0000"));

  if (!/side-band-64k/.test(capabilities)) return Buffer.concat(lines);
  return Buffer.concat([
    ...result.messages.map((message) => band(2, Buffer.from(message + "\n"))),
    band(1, Buffer.concat(lines)),
    Buffer.from("0000"),
  ]);
}

async function advertise(store, res) {
  const current = await manifest.read(store);
  const refs = Object.entries(current.refs).sort(([a], [b]) => (a < b ? -1 : 1));
  const parts = [pkt("# service=git-receive-pack\n"), Buffer.from("0000")];

  if (!refs.length) parts.push(pkt(ZERO + " capabilities^{}\0" + CAPABILITIES + "\n"));
  refs.forEach(([ref, oid], i) => parts.push(pkt(oid + " " + ref + (i === 0 ? "\0" + CAPABILITIES : "") + "\n")));
  parts.push(Buffer.from("0000"));

  res.writeHead(200, { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-cache" });
  res.end(Buffer.concat(parts));
}

async function createReceiveServer({ store, cache, lock, limit }) {
  const results = [];

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET") return await advertise(store, res);

      const source = req.headers["content-encoding"] === "gzip" ? req.pipe(zlib.createGunzip()) : req;
      const iterator = source[Symbol.asyncIterator]();
      const { lines, rest } = await readCommands(iterator);
      const { commands, capabilities } = parse(lines);

      const result = await receive({
        store,
        cache,
        lock,
        commands,
        pack: remainder(rest, iterator),
        limit,
        sizeHint: Number(req.headers["content-length"] || 0),
      });
      results.push(result);

      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
      res.end(report(capabilities, result));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err.stack));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: "http://127.0.0.1:" + server.address().port + "/repo.git",
    results,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Runs `git push` the way a user does, without blocking this process (which
// is where the server runs)
function push(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["push", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString() }));
  });
}

module.exports = { createReceiveServer, push };
