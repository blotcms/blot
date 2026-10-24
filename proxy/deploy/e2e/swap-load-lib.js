// Shared by swap-load-stub.js (the upstream) and swap-load.js (the load
// generator and checks): every body the stub serves is a pure function of
// (host, path, generation), so the checker can rebuild what the upstream sent
// for any generation and compare it byte for byte with what the proxy
// delivered. Plain node, no dependencies.
const crypto = require("crypto");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// A page: ~6 KB of text/html. The first line names the host, path and
// generation, so a body served for the wrong URL, or from before a purge, is
// recognisable by eye as well as by comparison.
function pageBody(host, path, gen) {
  const lines = [`<html><body><!-- ${JSON.stringify({ host, path, gen })} -->`];
  let size = lines[0].length;
  for (let i = 0; size < 6000; i++) {
    const line = `<p>${sha256(`${host}|${path}|${gen}|${i}`)}</p>`;
    lines.push(line);
    size += line.length;
  }
  lines.push("</body></html>");
  return Buffer.from(lines.join("\n"));
}

// A large file: 2.5 MB, well over what a cache fill buffers in memory.
// 64 bytes of hex per block, each block different, so any slice identifies the
// generation it came from.
const LARGE_BLOCKS = 40960;
function largeBody(host, path, gen) {
  const seed = `${host}|${path}|${gen}|`;
  const out = Buffer.alloc(LARGE_BLOCKS * 64);
  for (let i = 0; i < LARGE_BLOCKS; i++) out.write(sha256(seed + i), i * 64, "ascii");
  return out;
}

const isLarge = (path) => path.startsWith("/large");

function bodyFor(host, path, gen) {
  return isLarge(path) ? largeBody(host, path, gen) : pageBody(host, path, gen);
}

// ETag a page carries: the generation is in it, so a 304 can be placed
const etagFor = (gen, body) => `"g${gen}-${sha256(body).slice(0, 12)}"`;
const genOfEtag = (etag) => {
  const m = /^(?:W\/)?"g(\d+)-/.exec(etag || "");
  return m ? parseInt(m[1], 10) : null;
};

// Server-sent events the stub's status stream sends before ending
const SSE_EVENTS = 30;

module.exports = { sha256, pageBody, largeBody, isLarge, bodyFor, etagFor, genOfEtag, SSE_EVENTS };
