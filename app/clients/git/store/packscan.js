// Reads an incoming pack file front to back, far enough to know which deltas
// name an object the pack does not contain. A push from a client is a thin
// pack: its deltas may be against objects the repository already has, and
// `git index-pack --fix-thin` can only complete it if it can find them.
//
// It reuses the pack reader, pointed at the file in scratch, so a pack is
// walked the way it is read from the store: entry by entry, each inflated in
// pieces and discarded, so memory stays bounded however large the pack is.
const crypto = require("crypto");
const fs = require("fs/promises");
const { CorruptError } = require("./errors");
const { openPack, isDelta } = require("./pack");

// A file as the one-key object store the pack reader wants
function fileStore(file, handle) {
  return {
    head: async () => ({ size: (await handle.stat()).size }),
    read: async (key, offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
  };
}

// { count, whole, bases } for the pack at `file`: how many entries it has,
// the IDs of the objects it stores whole, and the IDs its REF_DELTA entries
// name. The bases which are not in `whole` are what a thin pack needs from
// the repository (or are themselves deltas in this pack, which index-pack
// resolves). Throws CorruptError if the file is not a well-formed pack.
async function scanPack(file) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);

    if (size < 32 || bytesRead < 12 || header.toString("latin1", 0, 4) !== "PACK" || header.readUInt32BE(4) !== 2) {
      throw new CorruptError("Not a version 2 pack");
    }

    const count = header.readUInt32BE(8);
    const pack = openPack({ store: fileStore(file, handle), key: "incoming", size, name: "the pushed pack" });
    const whole = new Set();
    const bases = new Set();
    let at = 12;

    for (let i = 0; i < count; i++) {
      if (at >= size - 20) throw new CorruptError("The pack has fewer entries than it says");

      const entry = await pack.open(at);
      const hash = isDelta(entry) ? null : crypto.createHash("sha1").update(entry.type + " " + entry.size + "\0");
      for await (const chunk of entry.output) if (hash) hash.update(chunk);

      if (hash) whole.add(hash.digest("hex"));
      else if (entry.baseOid) bases.add(entry.baseOid);
      at = entry.end();
    }

    if (at + 20 !== size) throw new CorruptError("The pack has data after its last entry");
    return { count, whole, bases };
  } finally {
    await handle.close();
  }
}

module.exports = { scanPack };
