// Run as a process of its own by the scratch spec, not a spec itself:
//
//   node --expose-gc measureStream.js <pack dir> <scratch dir> <oid> <max size>
//
// Loads the packs in a directory into a memory store, streams one object (a
// delta over `max size`, the reader's in-memory cap) to the end through scratch
// space, and prints how much the memory the process holds (heap and Buffers)
// grew at its peak while doing so, after a collection each time it looks, and
// then the size of what came out. A process of its own is needed for the
// reasons in measureMaterialize.js.
const fs = require("fs");
const path = require("path");
const createMemoryStore = require("../../objectStore/memory");
const createReader = require("../../reader");
const createCache = require("../../cache");

async function main([packDir, scratchDir, oid, maxSize]) {
  const store = createMemoryStore();
  const packs = [];

  for (const file of fs
    .readdirSync(packDir)
    .filter((f) => f.endsWith(".pack"))) {
    const name = file.slice(0, -".pack".length);
    const pack = fs.readFileSync(path.join(packDir, file));
    const idx = fs.readFileSync(path.join(packDir, name + ".idx"));

    await store.put("packs/" + name + ".pack", pack);
    await store.put("packs/" + name + ".idx", idx);
    packs.push({ name, size: pack.length, idxSize: idx.length });
  }

  const cache = createCache({
    dir: scratchDir,
    maxBytes: 4 * 1024 * 1024 * 1024,
  });
  const reader = createReader({
    store,
    packs,
    scratch: cache,
    maxSize: Number(maxSize),
  });
  const held = () => {
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.arrayBuffers;
  };
  global.gc();
  const before = held();
  let peak = before;
  const sample = () => {
    // Collecting first leaves only what is still held
    global.gc();
    peak = Math.max(peak, held());
  };

  // Building the object happens inside stream(), so it is sampled on a timer
  const timer = setInterval(sample, 20);
  const got = await reader.stream(oid);
  clearInterval(timer);
  sample();

  // Streaming it out is sampled between chunks, where nothing is in flight
  let bytes = 0;
  let chunks = 0;
  for await (const chunk of got.data) {
    bytes += chunk.length;
    if (++chunks % 128 === 0) sample();
  }

  sample();
  console.log(JSON.stringify({ growth: peak - before, bytes, size: got.size }));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}
