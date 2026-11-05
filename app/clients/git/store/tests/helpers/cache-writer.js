// A process of its own writing to a shared cache, for tests/cache.js:
//
//   node cache-writer.js <dir> <maxBytes> <prefix> <count> <entry bytes>
//
// Puts <count> entries, reading some back as it goes, and sends its parent
// { stored, walks, maxSeen }: how many puts were stored, how many walks it
// ran, and the most bytes it saw in the entries directory after any put.
const fs = require("fs");
const path = require("path");
const createCache = require("../../cache");

const [dir, maxBytes, prefix, count, length] = process.argv.slice(2);

function entryBytes() {
  let total = 0;
  const root = path.join(dir, "entries");
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    try {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    } catch (err) {
      // evicted while we were counting
    }
  }
  return total;
}

(async () => {
  const cache = createCache({ dir, maxBytes: Number(maxBytes), bucketMs: 1, touchEveryMs: 0, walkGapMs: 0, refreshMs: 0, publishDelayMs: 0 });
  await cache.ready();

  let stored = 0;
  let maxSeen = 0;
  for (let i = 0; i < Number(count); i++) {
    if (await cache.put(prefix + i, Buffer.alloc(Number(length), i % 256))) stored++;
    if (i % 3 === 0) await cache.get(prefix + Math.floor(i / 2));
    maxSeen = Math.max(maxSeen, entryBytes());
  }
  await cache.settle();
  const { walks } = cache.stats();
  await cache.close();
  process.send({ stored, walks, maxSeen }, () => process.exit(0));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
