// Reading the commit graph from the history packs: pieces made by real git, a
// pack with deltified commits, and what is refused.
const zlib = require("zlib");
const path = require("path");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { readHistory } = require("../history");
const { CorruptError } = require("../errors");

const message = (i) =>
  "Release notes\n" +
  "A line which repeats in every commit message, so git can store them as deltas.\n".repeat(
    30
  ) +
  "Number " +
  i +
  "\n";

describe("git store history", function () {
  timeout(60 * 1000);

  let dir;
  let repo;
  let commits; // oldest first
  let store;

  // A pack of the given commits, uploaded, and the manifest entry for it
  async function upload(oids, { deltas = true } = {}) {
    const pack = fx.indexPack(
      fx.git(
        repo,
        [
          "pack-objects",
          "--stdout",
          "-q",
          ...(deltas ? ["--window=100", "--depth=50"] : ["--depth=0"]),
        ],
        oids.join("\n") + "\n"
      )
    );
    const entry = await fx.upload(store, pack, oids.length);
    return { entry, pack };
  }

  beforeAll(function () {
    dir = fx.tempDir();
    repo = path.join(dir, "repo");
    fx.buildFixture(repo, { commits: 1, large: false });
    for (let i = 0; i < 20; i++)
      fx.git(repo, ["commit", "--allow-empty", "-q", "-m", message(i)]);
    commits = fx.text(repo, ["rev-list", "--reverse", "HEAD"]).split("\n");
  });

  afterAll(() => fx.remove(dir));
  beforeEach(() => (store = createMemoryStore()));

  const manifestOf = (history, pieces) => ({ history, historyPieces: pieces });

  async function failure(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  }

  it("reads the parents of every commit in the pieces and the history pack", async function () {
    const old = await upload(commits.slice(0, 8));
    const piece = await upload(commits.slice(8, 14));
    const newer = await upload(commits.slice(14));

    const graph = await readHistory({
      store,
      manifest: manifestOf(old.entry, [piece.entry, newer.entry]),
    });

    expect(graph.size).toBe(commits.length);
    for (const oid of commits) {
      const parents = fx
        .text(repo, ["rev-list", "--parents", "-n", "1", oid])
        .split(" ")
        .slice(1);
      expect(graph.has(oid)).toBe(true);
      expect(graph.parents(oid)).toEqual(parents);
    }
    expect(graph.has("a".repeat(40))).toBe(false);
    expect(graph.parents("a".repeat(40))).toBeUndefined();
  });

  it("reads commits stored as deltas", async function () {
    const { entry, pack } = await upload(commits);

    // Git stores similar commit messages as deltas, which is what this is for
    expect(fx.listEntries(pack).some((e) => e.depth > 0)).toBe(true);

    const graph = await readHistory({
      store,
      manifest: manifestOf(null, [entry]),
    });
    expect(graph.size).toBe(commits.length);
    expect(graph.parents(commits[19])).toEqual([commits[18]]);
    expect(graph.parents(commits[0])).toEqual([]);
  });

  it("reads a repository with no history", async function () {
    const graph = await readHistory({ store, manifest: { history: null } });
    expect(graph.size).toBe(0);
  });

  it("reads each pack once, and from the cache after that", async function () {
    const cache = createCache({
      dir: path.join(dir, "cache"),
      maxBytes: 8 * 1024 * 1024,
    });
    const { entry } = await upload(commits);
    const manifest = manifestOf(null, [entry]);

    await readHistory({ store, cache, manifest });
    expect(store.stats.gets).toBe(1);

    await readHistory({ store, cache, manifest });
    expect(store.stats.gets).toBe(typeof zlib.crc32 === "function" ? 1 : 2);
  });

  it("gives up on a history bigger than it was told to hold", async function () {
    const { entry } = await upload(commits);
    expect(
      await readHistory({
        store,
        manifest: manifestOf(null, [entry]),
        maxBytes: entry.size - 1,
      })
    ).toBe(null);
    expect(store.stats.gets).toBe(0);
  });

  it("gives up on commits that inflate past the budget, before inflating the rest", async function () {
    const { entry, pack } = await upload(commits);
    const entries = fx.listEntries(pack);
    const manifest = manifestOf(null, [entry]);

    // The size of the commits once inflated (verify-pack gives a delta's own size),
    // many times the pack
    const sizes = fx
      .text(
        repo,
        ["cat-file", "--batch-check=%(objectsize)"],
        commits.join("\n") + "\n"
      )
      .split("\n")
      .map(Number);
    const expanded = sizes.reduce((sum, n) => sum + n, 0);
    expect(entry.size).toBeLessThan(expanded / 10);

    expect(
      await readHistory({ store, manifest, maxExpanded: expanded - 1 })
    ).toBe(null);
    expect(
      (await readHistory({ store, manifest, maxExpanded: expanded * 2 })).size
    ).toBe(commits.length);

    // A budget of one commit stops at the first or second entry
    const inflates = spyOn(zlib, "inflateSync").and.callThrough();
    expect(
      await readHistory({ store, manifest, maxExpanded: entries[0].size + 1 })
    ).toBe(null);
    expect(inflates.calls.count()).toBeLessThanOrEqual(2);
  });

  it("refuses a pack that is not what the manifest says, or not commits", async function () {
    const { entry, pack } = await upload(commits.slice(0, 4));
    const wrong = { ...entry, size: entry.size + 1 };
    expect(
      await failure(readHistory({ store, manifest: manifestOf(null, [wrong]) }))
    ).toEqual(jasmine.any(CorruptError));

    // A pack of a tree is not a history pack
    const tree = fx.text(repo, ["rev-parse", "HEAD^{tree}"]);
    const trees = fx.indexPack(
      fx.git(repo, ["pack-objects", "--stdout", "-q"], tree + "\n")
    );
    const treeEntry = await fx.upload(store, trees, 1);
    expect(
      await failure(
        readHistory({ store, manifest: manifestOf(null, [treeEntry]) })
      )
    ).toEqual(jasmine.any(CorruptError));

    // A flipped byte in a compressed commit
    const damaged = Buffer.from(pack.pack);
    damaged[40] ^= 0xff;
    await store.put("packs/" + entry.name + ".pack", damaged);
    expect(
      await failure(readHistory({ store, manifest: manifestOf(null, [entry]) }))
    ).not.toBe(null);
  });
});
