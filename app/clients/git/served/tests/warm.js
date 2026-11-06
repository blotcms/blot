describe("git store: warming the cache on start", function () {
  // A blog on the git client with a clone, a memory store per blog, and the
  // store's log lines kept
  require("clients/git/tests/setup")({ clone: false, client: true, lines: true });

  var fs = require("fs");
  var path = require("path");  var config = require("config");
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

  describe("the packs", function () {
    var Client = require("clients/git/tests/setup/client");
    var Readable = require("stream").Readable;
    var packcache = require("clients/git/store/packcache");

    // A store which is only packs of the given sizes, to see the order and the
    // threshold without a repository
    function fake(id, packs, log) {
      return {
        id: id,
        head: async function () {
          return { size: 1, lastModified: 0 };
        },
        stream: function (key) {
          log.push(id + ":" + key);
          var name = key.replace(/^packs\//, "").replace(/\.pack$/, "");
          var pack = packs.filter(function (p) {
            return p.name === name;
          })[0];
          return Readable.from([Buffer.alloc(pack.size, 7)]);
        },
      };
    }

    function repo(id, time, packs, log) {
      return {
        blogID: id,
        store: fake(id, packs, log),
        time: time,
        manifest: { seq: 1, packs: packs, history: null, historyPieces: [] },
      };
    }

    function pack(n, size, seq) {
      return { name: "pack-" + String(n).repeat(40), size: size, idxSize: 1, objects: 1, seq: seq };
    }

    var options = { pause: 0, busyWait: 0, force: true };

    it("fetches the packs of the most recently written repositories first, newest packs first", async function () {
      await context.cache().clear();
      var log = [];
      var repos = {
        old: repo("old", 1000, [pack(1, 100, 1)], log),
        new: repo("new", 3000, [pack(2, 100, 1), pack(3, 100, 2)], log),
        mid: repo("mid", 2000, [pack(4, 100, 1)], log),
      };

      var result = await warm.runPacks({
        ...options,
        ids: ["old", "new", "mid"],
        load: async function (id) {
          return repos[id];
        },
      });

      expect(result.order).toEqual(["new", "mid", "old"]);
      expect(result.packs).toBe(4);
      expect(result.stopped).toBe("done");
      expect(log[0]).toBe("new:packs/" + pack(3, 1, 1).name + ".pack");
      expect(log.indexOf("new:packs/" + pack(2, 1, 1).name + ".pack")).toBe(1);
      expect(log[2]).toMatch(/^mid:/);
      expect(log[3]).toMatch(/^old:/);

      var line = this.storeLines("warm-packs").pop();
      expect(line).toContain("op=warm-packs");
      expect(line).toContain("outcome=warmed");
      expect(line).toContain("repos=3 packs=4 cached=0 skipped=0");
      expect(line).toContain("stopped=done");
    });

    it("skips a pack too big to cache without stopping the warm", async function () {
      var cache = context.cache();
      await cache.clear();
      var log = [];
      var huge = pack(9, 8 * 1024 * 1024 * 1024, 3);
      var repos = {
        a: repo("a", 2000, [huge, pack(1, 100, 2)], log),
        b: repo("b", 1000, [pack(2, 100, 1)], log),
      };

      var result = await warm.runPacks({
        ...options,
        ids: ["a", "b"],
        limit: cache.stats().entryBytes + 1500,
        load: async function (id) {
          return repos[id];
        },
      });

      expect(result.stopped).toBe("done");
      expect(result.skipped).toBe(1);
      expect(result.packs).toBe(2);
      expect(log.join(" ")).not.toContain(huge.name);
    });

    it("destroys the download when the cache declines the pack", async function () {
      var cache = context.cache();
      await cache.clear();
      var source;
      var store = {
        id: "declined",
        stream: function () {
          source = new Readable({ read: function () {} });
          return source;
        },
      };
      var put = cache.putStream;
      cache.putStream = async function (key, wrapper) {
        wrapper.destroy();
        return false;
      };

      try {
        var outcome = await require("clients/git/store/warm").warmPack({
          store: store,
          cache: cache,
          pack: pack(1, 100, 1),
          bytesPerSecond: 1000000,
        });
        expect(outcome).not.toBe("fetched");
        expect(source.destroyed).toBe(true);
      } finally {
        cache.putStream = put;
      }
    });

    it("takes no place in the git limiter, so a Blot commit is not delayed by it", async function () {
      await context.cache().clear();
      var limiter = require("clients/git/limiter");
      var log = [];
      var slow = repo("slow", 1, [pack(1, 100, 2), pack(2, 100, 1)], log);
      var stream = slow.store.stream;
      slow.store.stream = function (key) {
        var source = stream(key);
        return Readable.from(
          (async function* () {
            await new Promise(function (resolve) {
              setTimeout(resolve, 100);
            });
            yield* source;
          })()
        );
      };

      var started = limiter.stats().background.started;
      var seen = 0;
      var poll = setInterval(function () {
        var lane = limiter.stats().background;
        seen = Math.max(seen, lane.running + lane.waiting);
      }, 10);

      var result = await warm.runPacks({ ...options, ids: ["slow"], load: async () => slow });
      clearInterval(poll);

      expect(result.packs).toBe(2);
      expect(seen).toBe(0);
      expect(limiter.stats().background.started).toBe(started);
    });

    it("stops at the threshold, counting what is already cached", async function () {
      var cache = context.cache();
      await cache.clear();
      var log = [];
      var repos = { a: repo("a", 2000, [pack(1, 1000, 2), pack(2, 1000, 1)], log), b: repo("b", 1000, [pack(3, 1000, 1)], log) };
      var base = cache.stats().entryBytes;
      // Room for one pack and a bit
      var limit = base + 1500;

      var result = await warm.runPacks({
        ...options,
        ids: ["a", "b"],
        limit: limit,
        load: async function (id) {
          return repos[id];
        },
      });

      expect(result.packs).toBe(1);
      expect(result.stopped).toBe("threshold");
      expect(log).toEqual(["a:packs/" + pack(1, 1, 1).name + ".pack"]);
      expect(this.storeLines("warm-packs").pop()).toContain("stopped=threshold");
    });

    it("skips the packs the cache already holds at the right size", async function () {
      var cache = context.cache();
      await cache.clear();
      var log = [];
      var repos = { a: repo("a", 1, [pack(1, 100, 2), pack(2, 100, 1)], log) };
      var load = async function (id) {
        return repos[id];
      };

      var first = await warm.runPacks({ ...options, ids: ["a"], load: load });
      expect(first.packs).toBe(2);

      log.length = 0;
      var second = await warm.runPacks({ ...options, ids: ["a"], load: load });
      expect(second.packs).toBe(0);
      expect(second.cached).toBe(2);
      expect(log).toEqual([]);
      expect(await cache.size(packcache.cacheKeyOf(repos.a.store, pack(1, 1, 1).name))).toBe(100);
    });

    it("stops when the cache declines a pack", async function () {
      var cache = context.cache();
      await cache.clear();
      var log = [];
      // A cache which is nearly full (or short of disk) declines every put
      var repos = { a: repo("a", 1, [pack(1, 100, 2), pack(2, 100, 1), pack(3, 100, 0)], log) };
      var extra = 0;
      var put = cache.putStream;
      cache.putStream = async function (key, source) {
        source.destroy();
        extra++;
        return false;
      };
      var stats = cache.stats;
      cache.stats = function () {
        var out = stats();
        out.declined += extra;
        return out;
      };

      try {
        var result = await warm.runPacks({
          ...options,
          ids: ["a"],
          load: async function (id) {
            return repos[id];
          },
        });
        expect(result.stopped).toBe("declined");
        expect(result.packs).toBe(0);
        expect(log.length).toBeLessThan(3);
      } finally {
        cache.putStream = put;
        cache.stats = stats;
      }
    });

    it("makes a later clone read no pack from the store", async function () {
      var cache = context.cache();
      await cache.clear();
      var store = this.stores[this.blog.id];

      var result = await warm.runPacks({ ...options, ids: [this.blog.id] });
      expect(result.packs).toBeGreaterThan(0);

      var reads = [];
      ["read", "stream", "get"].forEach(function (method) {
        var original = store[method];
        store[method] = function (key) {
          if (/\.pack$/.test(key)) reads.push(method + " " + key);
          return original.apply(this, arguments);
        };
      });

      var clone = await Client.clone({ url: this.repoUrl, directory: path.join(this.tmp, "warmed-clone") });
      expect(await clone.head()).toBe(await this.local.head());
      expect(reads).toEqual([]);
    });

    it("does not run twice within 12 hours, and not while another process warms", async function () {
      await context.cache().clear();
      var clock = Date.now();
      var first = await warm.runPacks({ ids: [this.blog.id], pause: 0, now: () => clock });
      expect(first.outcome).toBe("warmed");

      var soon = await warm.runPacks({ ids: [this.blog.id], pause: 0, now: () => clock + 11 * 60 * 60 * 1000 });
      expect(soon.reason).toBe("warm");
      expect(this.storeLines("warm-packs").pop()).toContain("reason=warm");

      var later = await warm.runPacks({ ids: [this.blog.id], pause: 0, now: () => clock + 13 * 60 * 60 * 1000 });
      expect(later.outcome).toBe("warmed");

      var held = await context.cache().lock("warm", { staleMs: 60000 });
      var locked = await warm.runPacks({ ids: [this.blog.id], force: true });
      await held.release();
      expect(locked.reason).toBe("locked");
    });
  });
});
