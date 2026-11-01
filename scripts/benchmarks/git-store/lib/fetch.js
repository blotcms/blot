// Smart HTTP (protocol v0) for a store-backed repository: the ref
// advertisement and upload-pack (clone and fetch).
const zlib = require("zlib");
const { parseCommit } = require("./gitobj");
const { planPack, packStream } = require("./clone");

const AGENT = "agent=blot-git-store-spike/0";
const UPLOAD_CAPS = "multi_ack_detailed side-band-64k ofs-delta " + AGENT;
const RECEIVE_CAPS = "report-status delete-refs side-band-64k ofs-delta quiet " + AGENT;

// The most commits one fetch will walk to find what the client already has;
// past it the client is sent everything, which is slow but never wrong
const MAX_WALK = 20000;
const MAX_HAVES = 4096;

const pkt = (data) => {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from((buffer.length + 4).toString(16).padStart(4, "0")), buffer]);
};
const FLUSH = Buffer.from("0000");

function parsePackets(buffer) {
  const lines = [];
  let i = 0;
  while (i < buffer.length) {
    const length = parseInt(buffer.toString("latin1", i, i + 4), 16);
    if (Number.isNaN(length)) throw new Error("Bad pkt-line");
    if (length === 0) {
      lines.push(null);
      i += 4;
      continue;
    }
    if (length < 4) {
      i += 4;
      continue;
    }
    lines.push(buffer.subarray(i + 4, i + length));
    i += length;
  }
  return lines;
}

async function readBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  let body = Buffer.concat(parts);
  if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
  return body;
}

function advertisement(service, manifest) {
  const names = Object.keys(manifest.refs).sort();
  const caps = service === "git-upload-pack" ? UPLOAD_CAPS : RECEIVE_CAPS;
  const out = [pkt("# service=" + service + "\n"), FLUSH];
  const head = manifest.head && manifest.refs[manifest.head];

  if (service === "git-upload-pack" && head) {
    out.push(pkt(head + " HEAD\0" + caps + " symref=HEAD:" + manifest.head + "\n"));
    for (const name of names) out.push(pkt(manifest.refs[name] + " " + name + "\n"));
  } else if (names.length) {
    names.forEach((name, i) => out.push(pkt(manifest.refs[name] + " " + name + (i === 0 ? "\0" + caps : "") + "\n")));
  } else {
    out.push(pkt("0".repeat(40) + " capabilities^{}\0" + caps + "\n"));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// The newest push whose refs the client has: every tip in that push's ref
// snapshot is one of the commits the client has, or an ancestor of one. A
// commit-only walk, pruned by the push each commit arrived in (a parent is
// never in a newer push than its child). Returns 0 (send everything) when
// there is no such push or the walk would be too long.
async function findFloor(repo, commons) {
  const memo = new Map();
  let walked = 0;

  async function commit(oid) {
    const found = await repo.read(oid);
    if (!found || found.type !== "commit") throw new Error("Not a commit: " + oid);
    return parseCommit(found.data);
  }

  async function reaches(tip) {
    if (memo.has(tip)) return memo.get(tip);
    const tipSeq = await repo.seqOf(tip);
    const seen = new Set(commons);
    const queue = [...commons];
    let ok = seen.has(tip);

    while (queue.length && !ok) {
      const oid = queue.pop();
      if ((await repo.seqOf(oid)) < tipSeq) continue;
      if (++walked > MAX_WALK) throw new Error("walk limit");
      for (const parent of (await commit(oid)).parents) {
        if (parent === tip) ok = true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    memo.set(tip, ok);
    return ok;
  }

  try {
    for (const snapshot of [...repo.manifest.snapshots].reverse()) {
      let all = true;
      for (const tip of Object.values(snapshot.refs)) {
        if (!(await reaches(tip))) {
          all = false;
          break;
        }
      }
      if (all) return { floor: snapshot.seq, walked };
    }
  } catch (err) {
    if (err.message !== "walk limit") throw err;
  }
  return { floor: 0, walked };
}

// Handles the POST of git-upload-pack. `respond` gets { status, headers }
// first, then the body is written to `res`. Returns facts about the work.
async function uploadPack({ req, res, repo, store }) {
  const lines = parsePackets(await readBody(req));
  const wants = [];
  const haves = [];
  let done = false;
  for (const raw of lines) {
    if (!raw) continue;
    const line = raw.toString("utf8").replace(/\n$/, "");
    if (line.startsWith("want ")) wants.push(line.slice(5, 45));
    else if (line.startsWith("have ")) haves.push(line.slice(5, 45));
    else if (line === "done") done = true;
    else if (/^(shallow|deepen|filter)/.test(line)) {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.end(pkt("ERR shallow, deepen and filter are not supported\n"));
      return { rejected: true };
    }
  }

  const known = new Set(Object.values(repo.manifest.refs));
  for (const snapshot of repo.manifest.snapshots) for (const tip of Object.values(snapshot.refs)) known.add(tip);
  const bad = wants.find((oid) => !known.has(oid));
  if (bad) {
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    res.end(pkt("ERR upload-pack: not our ref " + bad + "\n"));
    return { rejected: true };
  }

  // Which of the client's haves we have
  const commons = [];
  for (const oid of haves.slice(0, MAX_HAVES)) if (await repo.reader.has(oid)) commons.push(oid);

  res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" });

  if (!done) {
    const out = [];
    for (const oid of commons) out.push(pkt("ACK " + oid + " common\n"));
    if (commons.length) out.push(pkt("ACK " + commons[commons.length - 1] + " ready\n"));
    out.push(pkt("NAK\n"));
    res.end(Buffer.concat(out));
    return { negotiation: true, haves: haves.length, commons: commons.length };
  }

  const { floor, walked } = commons.length ? await findFloor(repo, commons) : { floor: 0, walked: 0 };
  const send = repo.manifest.packs.filter((p) => p.seq > floor);
  const plan = await planPack(store, send);
  const stats = {};

  res.write(pkt(commons.length ? "ACK " + commons[commons.length - 1] + "\n" : "NAK\n"));

  let bytes = 0;
  for await (const chunk of packStream(store, plan, stats)) {
    bytes += chunk.length;
    for (let at = 0; at < chunk.length; at += 65515) {
      const part = pkt(Buffer.concat([Buffer.from([1]), chunk.subarray(at, at + 65515)]));
      if (!res.write(part)) await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  res.end(FLUSH);

  return { haves: haves.length, commons: commons.length, floor, walked, packsSent: send.length, packsTotal: repo.manifest.packs.length, objects: plan.total, skipped: plan.skipped, bytes, ...stats };
}

module.exports = { advertisement, uploadPack, parsePackets, readBody, pkt, FLUSH };
