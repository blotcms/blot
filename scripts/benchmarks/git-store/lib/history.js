// The history pack: every commit of the repository, whole, in one pack. This
// measures what it costs to read all of it at once and to find, from it alone,
// the newest push whose refs a client already has, which is the commit-only
// ancestor walk a fetch needs. Compare with the walk through the live packs
// (fetch with `--walk`): one request for the pack instead of one per commit.
const zlib = require("zlib");
const toxiproxy = require("./toxiproxy");
const { connect } = require("./stores");
const createManifests = require("./manifests");
const { layout } = require("../../../../app/clients/git/store");
const { parseCommit } = require("./gitobj");
const { loadMeta, tipAfterPush } = require("./readsuites");
const crypto = require("crypto");

// All the commits of a pack of whole commits, as a Map of ID -> parents
function readCommits(buffer) {
  const count = buffer.readUInt32BE(8);
  const parents = new Map();
  let at = 12;
  for (let i = 0; i < count; i++) {
    let byte = buffer[at++];
    const code = (byte >> 4) & 7;
    if (code !== 1) throw new Error("The history pack holds something other than commits");
    while (byte & 0x80) byte = buffer[at++];
    const out = zlib.inflateSync(buffer.subarray(at), { info: true });
    at += out.engine.bytesWritten;
    const oid = crypto.createHash("sha1").update("commit " + out.buffer.length + "\0").update(out.buffer).digest("hex");
    parents.set(oid, parseCommit(out.buffer).parents);
  }
  return parents;
}

async function historySuite({ repo, profile, record }) {
  const meta = loadMeta(repo);
  await toxiproxy.useProfile(profile);
  const { store, counters, close } = connect({ blogID: repo, via: profile === "direct" ? "direct" : "proxied" });
  const manifests = createManifests({ store });
  const current = await manifests.read();
  const history = current.history;
  counters.take();

  const started = process.hrtime.bigint();
  const body = await store.get(layout.packKey(history.name), { maxBytes: 1 << 30 });
  const fetchedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const parents = readCommits(body);

  // A client which has only the tip of the push before the last
  const have = tipAfterPush(meta, meta.seq - 1);
  const reachable = new Set([have]);
  const queue = [have];
  while (queue.length) {
    for (const parent of parents.get(queue.pop())) {
      if (!reachable.has(parent)) {
        reachable.add(parent);
        queue.push(parent);
      }
    }
  }
  let floor = 0;
  for (const snapshot of current.snapshots.filter((s) => s.seq <= history.through).reverse()) {
    if (Object.values(snapshot.refs).every((tip) => reachable.has(tip))) {
      floor = snapshot.seq;
      break;
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const counts = counters.take();

  record({
    suite: "history",
    repo,
    profile,
    commits: parents.size,
    historyPackBytes: history.size,
    historyIdxBytes: history.idxSize,
    bytesPerCommit: Math.round(history.size / history.objects),
    requests: Object.values(counts.http).reduce((n, r) => n + r.n, 0),
    bytesIn: counts.bytesIn,
    fetchMs: fetchedMs,
    ms,
    floor,
  });
  close();
}

module.exports = { historySuite };
