// The store as a host would use it: through index.js, from a push's packs to
// reading the repository back.
const store = require("../index");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");

describe("git store", function () {
  timeout(30 * 1000);

  it("exports its interface", function () {
    for (const name of [
      "createCache",
      "createMemoryStore",
      "createS3Store",
      "createReader",
      "readRanges",
    ]) {
      expect(typeof store[name]).toBe("function");
    }
    expect(typeof store.manifest.swap).toBe("function");
    expect(typeof store.errors.CorruptError).toBe("function");
  });

  it("stores a push's packs, swaps the manifest, and reads the repository back", async function () {
    const workDir = fx.tempDir();

    try {
      const fixture = fx.buildFixture(workDir + "/repo", {
        commits: 4,
        large: false,
      });
      fx.repackAll(fixture.dir);
      const oracle = fx.catAll(fixture.dir);

      const objects = store.createMemoryStore();
      const cache = store.createCache({
        dir: workDir + "/cache",
        maxBytes: 1024 * 1024,
      });
      const [pack] = fx.readPacks(fixture.dir);

      // Packs first, then the manifest which names them
      const entry = await fx.upload(objects, pack, oracle.size);
      const base = await store.manifest.read(objects);
      const next = store.manifest.advance(base, {
        refs: { "refs/heads/master": fixture.head },
        head: "refs/heads/master",
        packs: [entry],
      });
      await store.manifest.swap({
        store: objects,
        lock: (fn) => fn(),
        base,
        next,
      });

      // Later, perhaps on another host
      const current = await store.manifest.read(objects);
      expect(current.refs["refs/heads/master"]).toBe(fixture.head);

      const reader = store.createReader({
        store: objects,
        cache,
        packs: current.packs,
      });
      const commit = await reader.read(fixture.head);
      expect(commit.type).toBe("commit");
      expect(commit.data.equals(oracle.get(fixture.head).data)).toBe(true);
    } finally {
      fx.remove(workDir);
    }
  });
});
