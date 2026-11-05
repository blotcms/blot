describe("git store: warming the cache on start", function () {
  // A blog on the git client with a clone, a memory store per blog, and the
  // store's log lines kept
  require("clients/git/tests/setup")({ clone: false, client: true, lines: true });

  var fs = require("fs");
  var path = require("path");
  var config = require("config");
  var warm = require("clients/git/served/warm");
  var context = require("clients/git/served/context");

  beforeEach(async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");
  });

  it("fills an empty cache with the indexes and the history, and logs one line", async function () {
    var cache = context.cache();
    await cache.clear();

    var result = await warm.run({ ids: [this.blog.id] });

    expect(result.outcome).toBe("warmed");
    expect(result.blogs).toBe(1);
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.cached).toBe(0);
    expect(result.bytes).toBeGreaterThan(0);

    var line = this.storeLines("warm").pop();
    expect(line).toContain("op=warm");
    expect(line).toContain("outcome=warmed");
    expect(line).toContain("fetched=" + result.fetched);
    expect(line).toMatch(/requests=\d+/);
    expect(line).not.toContain(this.blog.handle);
  });

  it("is skipped once warm, and fetches nothing it already holds", async function () {
    await context.cache().clear();
    await warm.run({ ids: [this.blog.id] });

    expect((await warm.run({ ids: [this.blog.id] })).reason).toBe("warm");
    expect(this.storeLines("warm").pop()).toContain("reason=warm");

    var again = await warm.run({ ids: [this.blog.id], force: true });
    expect(again.outcome).toBe("warmed");
    expect(again.fetched).toBe(0);
    expect(again.cached).toBeGreaterThan(0);
  });

  it("is skipped while another process warms", async function () {
    var held = await context.cache().lock("warm", { staleMs: 60000 });
    var result = await warm.run({ ids: [this.blog.id], force: true });
    await held.release();

    expect(result.reason).toBe("locked");
  });

  it("removes the per-process caches which came before the shared one, once idle", async function () {
    var root = config.git_store.cache_directory;
    var old = path.join(root, "blot-blue-1");
    var busy = path.join(root, "blot-green-1");
    fs.mkdirSync(path.join(old, "entries"), { recursive: true });
    fs.mkdirSync(path.join(busy, "tmp"), { recursive: true });
    var hoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, hoursAgo, hoursAgo);

    await context.cache().ready();
    var removed = await warm.removeLegacy();

    expect(removed).toEqual(["blot-blue-1"]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
    expect(fs.existsSync(context.cacheDirectory())).toBe(true);
  });
});
