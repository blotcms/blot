// A minimal smart-HTTP client for measuring: it asks for a pack and reads it
// to the end without writing it anywhere, checking the pack's own SHA-1
// trailer as it goes. Real `git` clients are used for correctness; this is for
// timing the server's stream on its own.
const crypto = require("crypto");
const { pkt, FLUSH, parsePackets } = require("./fetch");

async function advertise(gitUrl, service = "git-upload-pack") {
  const started = process.hrtime.bigint();
  const res = await fetch(gitUrl + "/info/refs?service=" + service);
  const body = Buffer.from(await res.arrayBuffer());
  const refs = {};
  for (const packet of parsePackets(body)) {
    const m = packet && /^([0-9a-f]{40}) ([^\0\n ]+)/.exec(packet.toString("utf8"));
    if (m) refs[m[2]] = m[1];
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, status: res.status, refs, bytes: body.length };
}

function request(wants, haves, done) {
  const lines = [];
  wants.forEach((oid, i) => lines.push(pkt("want " + oid + (i === 0 ? " multi_ack_detailed side-band-64k ofs-delta agent=spike\n" : "\n"))));
  lines.push(FLUSH);
  for (const oid of haves) lines.push(pkt("have " + oid + "\n"));
  if (done) lines.push(pkt("done\n"));
  return Buffer.concat(lines);
}

// Reads a whole upload-pack response. Returns the pack's size, object count,
// whether its trailer matches its content, and the trailer.
async function readPack(res) {
  const started = process.hrtime.bigint();
  let firstByteMs = null;
  const hash = crypto.createHash("sha1");
  let held = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let packBytes = 0;
  let wire = 0;
  let header = null;
  let pending = Buffer.alloc(0);
  let sawFlush = false;

  const feed = (payload) => {
    packBytes += payload.length;
    if (!header) {
      held = Buffer.concat([held, payload]);
      if (held.length < 12) return;
      header = { objects: held.readUInt32BE(8), version: held.readUInt32BE(4), magic: held.toString("latin1", 0, 4) };
      payload = held;
    }
    tail = Buffer.concat([tail, payload]);
    if (tail.length > 20) {
      hash.update(tail.subarray(0, tail.length - 20));
      tail = tail.subarray(tail.length - 20);
    }
  };

  for await (const chunk of res.body) {
    if (firstByteMs === null) firstByteMs = Number(process.hrtime.bigint() - started) / 1e6;
    wire += chunk.length;
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (pending.length < 4) break;
      const length = parseInt(pending.toString("latin1", 0, 4), 16);
      if (length === 0) {
        sawFlush = true;
        pending = pending.subarray(4);
        continue;
      }
      if (pending.length < length) break;
      const band = pending[4];
      const body = pending.subarray(5, length);
      if (band === 1) feed(body);
      else if (band === 3) throw new Error("server error: " + body.toString());
      else if (band !== 2 && !/^(NAK|ACK)/.test(pending.toString("utf8", 4, Math.min(length, 7)))) {
        // an ACK/NAK line, not a band
      }
      pending = pending.subarray(length);
    }
  }

  const ok = header && header.magic === "PACK" && hash.digest().equals(tail);
  return {
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    firstByteMs,
    wire,
    packBytes,
    objects: header && header.objects,
    trailer: tail.toString("hex"),
    trailerOk: !!ok,
    complete: sawFlush,
  };
}

async function clone(gitUrl, wants) {
  const res = await fetch(gitUrl + "/git-upload-pack", { method: "POST", body: request(wants, [], true) });
  if (!res.ok) throw new Error("upload-pack " + res.status);
  return readPack(res);
}

// A fetch as git does it: one request with the haves and no "done", then one
// with "done" once the server says it is ready
async function fetchFrom(gitUrl, wants, haves) {
  const started = process.hrtime.bigint();
  const first = await fetch(gitUrl + "/git-upload-pack", { method: "POST", body: request(wants, haves, false) });
  const acks = (await first.text()).split("\n").filter((l) => /ACK|NAK/.test(l)).length;
  const res = await fetch(gitUrl + "/git-upload-pack", { method: "POST", body: request(wants, haves, true) });
  if (!res.ok) throw new Error("upload-pack " + res.status);
  const out = await readPack(res);
  return { ...out, ms: Number(process.hrtime.bigint() - started) / 1e6, negotiationLines: acks };
}

module.exports = { advertise, clone, fetchFrom, readPack, request };
