// Run as a process of its own by the materialize spec, not a spec itself:
//
//   node --expose-gc measureMaterialize.js <pack dir> <folder> <from|null> <to>
//
// Loads the packs in a directory into a memory store, materializes a commit
// into the folder, and prints how much the memory the process holds (heap and
// Buffers) grew at its peak while doing so, after a collection each time it
// looks. A process of its own is needed because the specs' holds a lot else,
// and because each chunk is a Buffer outside the heap which stays resident,
// though dead, until a GC, and V8 waits for 64 MiB of those before it collects.
const fs = require("fs");
const path = require("path");
const createMemoryStore = require("../../objectStore/memory");
const createReader = require("../../reader");
const materialize = require("../../materialize");
const createFolderSink = require("../../folderSink");

async function main([packDir, folder, from, to]) {
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

  const reader = createReader({ store, packs });
  const held = () => {
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.arrayBuffers;
  };
  global.gc();
  const before = held();
  let peak = before;
  const timer = setInterval(function () {
    // Collecting first leaves only what is still held
    global.gc();
    peak = Math.max(peak, held());
  }, 20);

  await materialize({
    reader,
    from: from === "null" ? null : from,
    to,
    sink: createFolderSink({ root: folder }),
  });
  clearInterval(timer);
  console.log(peak - before);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}
