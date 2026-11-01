// Generates a synthetic repository (generate.js) and uploads it to the spike's
// MinIO, directly (not through toxiproxy). Each pack is uploaded as soon as it
// is finished and its local file deleted, so the disk holds at most one pack
// plus the object store's copy.
const fs = require("fs");
const path = require("path");
const { manifest, layout } = require("../../../../app/clients/git/store");
const { generate, SPECS } = require("./generate");
const { connect, ensureBucket } = require("./stores");

const FREE_FLOOR = 3 * 1024 ** 3;

function freeBytes(dir) {
  const stats = fs.statfsSync(dir);
  return stats.bavail * stats.bsize;
}

async function removeRepo(store) {
  const keys = [];
  for await (const item of store.list("")) keys.push(item.key);
  for (const key of keys) await store.delete(key);
  return keys.length;
}

// workDir: where packs are built (scratch); metaFile: where the repository's
// facts are recorded for later runs
async function generateAndUpload({ specName, blogID, workDir, metaFile, overrides = {}, log = console.log }) {
  await ensureBucket();
  const { store, counters, close } = connect({ blogID, via: "direct" });
  await removeRepo(store);
  counters.take();

  fs.mkdirSync(workDir, { recursive: true });
  const spec = { ...SPECS[specName], ...overrides, dir: workDir };

  let base = manifest.empty();
  let next = base;
  let uploaded = 0;
  const packs = [];
  const started = Date.now();

  let historyEntry = null;
  const result = await generate(spec, {
    log,
    onHistory: async (history) => {
      await store.put(layout.packKey(history.name), fs.createReadStream(history.file));
      await store.put(layout.idxKey(history.name), history.idx);
      fs.unlinkSync(history.file);
      historyEntry = { name: history.name, size: history.size, idxSize: history.idxSize, objects: history.objects, through: history.through };
    },
    onPack: async (pack) => {
      if (freeBytes(workDir) < FREE_FLOOR) throw new Error("Free disk space is below 3 GiB; stopping");
      await store.put(layout.packKey(pack.name), fs.createReadStream(pack.file));
      await store.put(layout.idxKey(pack.name), pack.idx);
      fs.unlinkSync(pack.file);
      uploaded += pack.size + pack.idx.length;

      const entry = { name: pack.name, size: pack.size, idxSize: pack.idx.length, objects: pack.objects };
      packs.push({ ...entry, seq: pack.seq, kind: pack.kind, commits: pack.commits });

      const head = "refs/heads/master";
      next = manifest.advance(next, { refs: pack.refs, packs: [entry], head });
    },
  });

  next = { ...next, history: historyEntry };

  // Only the final manifest is written: the intermediate ones would be a
  // few GB of manifests for the uncompacted blog, and nothing reads them
  await store.putIfAbsent(layout.manifestKey(next.seq), manifest.serialize(next));
  await store.put(layout.LATEST_KEY, Buffer.from(JSON.stringify({ seq: next.seq }) + "\n"));

  const meta = {
    spec: specName,
    blogID,
    commits: result.commits,
    refs: result.refs,
    packs,
    seq: next.seq,
    history: historyEntry,
    manifestBytes: manifest.serialize(next).length,
    objects: packs.reduce((n, p) => n + p.objects, 0),
    packBytes: packs.reduce((n, p) => n + p.size, 0),
    idxBytes: packs.reduce((n, p) => n + p.idxSize, 0),
    uploadSeconds: (Date.now() - started) / 1000,
    uploadedBytes: uploaded,
  };
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  close();
  return meta;
}

module.exports = { generateAndUpload, removeRepo, freeBytes, FREE_FLOOR };
