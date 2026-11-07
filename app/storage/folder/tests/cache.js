// The content cache of the S3 backend, on its own: open() stands in for S3,
// so these need no bucket. The backend's use of it is specified in
// app/storage/tests/folder.js, under "on S3".
describe("storage/folder cache", function () {
  var config = require("config");
  var fs = require("fs-extra");
  var crypto = require("crypto");
  var { join } = require("path");
  var { Readable } = require("stream");
  var { createCache } = require("storage/folder/cache");

  var dir;
  var caches;

  beforeEach(async function () {
    await fs.ensureDir(config.tmp_directory);
    dir = await fs.mkdtemp(
      join(config.tmp_directory, "storage-folder-cache-spec-")
    );
    caches = [];
  });

  afterEach(async function () {
    caches.forEach(function (cache) {
      cache.stop();
    });
    await fs.remove(dir);
  });

  // No periodic check and no grace period unless a spec asks, so evictions
  // happen exactly when the budget says
  function open(options) {
    var cache = createCache(
      Object.assign(
        { dir: dir, maxBytes: 1000, graceMs: 0, checkIntervalMs: 0 },
        options
      )
    );
    caches.push(cache);
    return cache;
  }

  function sha1(text) {
    return crypto.createHash("sha1").update(text).digest("hex");
  }

  function spec(path, text, blogID) {
    return {
      blogID: blogID || "blog_a",
      path: path,
      version: sha1(text),
      size: Buffer.byteLength(text),
      sha1: sha1(text),
    };
  }

  // Stands in for S3: counts the opens of each path
  function source(text) {
    var opener = jasmine.createSpy("open").and.callFake(async function () {
      return Readable.from([Buffer.from(text)]);
    });
    return opener;
  }

  async function files() {
    var found = [];

    async function visit(current) {
      for (var entry of await fs
        .readdir(current, { withFileTypes: true })
        .catch(() => [])) {
        var full = join(current, entry.name);
        if (entry.isDirectory()) await visit(full);
        else found.push(full);
      }
    }

    await visit(dir);
    return found;
  }

  // Makes an entry look last used `ago` milliseconds ago, on disk
  async function age(local, ago) {
    var then = new Date(Date.now() - ago);
    await fs.utimes(local, then, then);
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
  }

  it("downloads on a miss and serves the copy on a hit", async function () {
    var cache = open();
    var a = source("hello");

    var first = await cache.get(spec("/a.txt", "hello"), a);
    var second = await cache.get(spec("/a.txt", "hello"), a);

    expect(first).toEqual(second);
    expect(first.indexOf(dir)).toEqual(0);
    expect(await fs.readFile(first, "utf8")).toEqual("hello");
    expect(a.calls.count()).toEqual(1);
    expect(cache.stats()).toEqual(
      jasmine.objectContaining({
        hits: 1,
        misses: 1,
        entries: 1,
        bytes: 5,
        fetchedBytes: 5,
      })
    );
  });

  it("keeps the file's own name, so its extension still means something", async function () {
    var cache = open();

    expect(
      await cache.get(spec("/photos/cat.JPG", "jpeg"), source("jpeg"))
    ).toMatch(/\/cat\.JPG$/);
  });

  it("uses a new key when the file's SHA-1 changes", async function () {
    var cache = open();
    var one = source("one");
    var two = source("two");

    var before = await cache.get(spec("/a.txt", "one"), one);
    var after = await cache.get(spec("/a.txt", "two"), two);

    expect(before).not.toEqual(after);
    expect(await fs.readFile(after, "utf8")).toEqual("two");
    expect(two.calls.count()).toEqual(1);
  });

  it("keys by blog and path as well as content", async function () {
    var cache = open();

    var a = await cache.get(spec("/a.txt", "same", "blog_a"), source("same"));
    var b = await cache.get(spec("/b.txt", "same", "blog_a"), source("same"));
    var c = await cache.get(spec("/a.txt", "same", "blog_b"), source("same"));

    expect(new Set([a, b, c]).size).toEqual(3);
  });

  it("evicts the least recently used entries when the budget is full", async function () {
    var cache = open({ maxBytes: 10 });

    var a = await cache.get(spec("/a.txt", "aaaa"), source("aaaa"));
    var b = await cache.get(spec("/b.txt", "bbbb"), source("bbbb"));

    // a is now more recent than b
    await cache.get(spec("/a.txt", "aaaa"), source("aaaa"));

    var c = await cache.get(spec("/c.txt", "cccc"), source("cccc"));

    expect(await fs.pathExists(a)).toBe(true);
    expect(await fs.pathExists(b)).toBe(false);
    expect(await fs.pathExists(c)).toBe(true);
    expect(cache.stats()).toEqual(
      jasmine.objectContaining({ entries: 2, bytes: 8, evictions: 1 })
    );
  });

  it("stores a file bigger than the budget, and evicts it next", async function () {
    var cache = open({ maxBytes: 4 });

    var big = await cache.get(spec("/big.txt", "too big"), source("too big"));

    expect(await fs.readFile(big, "utf8")).toEqual("too big");

    await cache.get(spec("/a.txt", "a"), source("a"));

    expect(await fs.pathExists(big)).toBe(false);
  });

  it("does not evict anything used within the grace period", async function () {
    var cache = open({ maxBytes: 4, graceMs: 60 * 1000 });

    var a = await cache.get(spec("/a.txt", "aaaa"), source("aaaa"));
    var b = await cache.get(spec("/b.txt", "bbbb"), source("bbbb"));

    expect(await fs.pathExists(a)).toBe(true);
    expect(await fs.pathExists(b)).toBe(true);
  });

  it("shares one download between concurrent gets of one key", async function () {
    var cache = open();
    var release;
    var gate = new Promise(function (resolve) {
      release = resolve;
    });
    var slow = jasmine.createSpy("open").and.callFake(async function () {
      await gate;
      return Readable.from([Buffer.from("slow")]);
    });

    var gets = [1, 2, 3].map(function () {
      return cache.get(spec("/s.txt", "slow"), slow);
    });

    // Every get has looked and missed before the bytes arrive
    await new Promise(function (resolve) {
      setTimeout(resolve, 50);
    });
    release();

    var paths = await Promise.all(gets);

    expect(new Set(paths).size).toEqual(1);
    expect(slow.calls.count()).toEqual(1);
    expect(await fs.readFile(paths[0], "utf8")).toEqual("slow");
  });

  it("never shows a download which fails part way", async function () {
    var cache = open();
    var seenDuring;
    var failing = async function () {
      var started = false;

      return new Readable({
        read: function () {
          var stream = this;
          if (started) return;
          started = true;
          stream.push("par");
          setTimeout(async function () {
            seenDuring = await files();
            stream.destroy(new Error("connection reset"));
          }, 10);
        },
      });
    };

    var err = await rejection(cache.get(spec("/p.txt", "partial"), failing));

    expect(err.message).toEqual("connection reset");

    // While the bytes were arriving only a temporary file existed, and
    // afterwards nothing is left
    expect(
      seenDuring.every(function (file) {
        return file.indexOf(join(dir, "tmp")) === 0;
      })
    ).toBe(true);
    expect(await files()).toEqual([]);
    expect(cache.stats().entries).toEqual(0);

    // The next try downloads it again
    expect(
      await fs.readFile(
        await cache.get(spec("/p.txt", "partial"), source("partial")),
        "utf8"
      )
    ).toEqual("partial");
  });

  it("refuses bytes which are not the version the index describes", async function () {
    var cache = open();

    var err = await rejection(
      cache.get(spec("/a.txt", "index"), source("other"))
    );

    expect(err.code).toEqual("ECHANGED");
    expect(await files()).toEqual([]);
    expect(cache.stats().changed).toEqual(1);
  });

  it("checks only the size where the index has no hash", async function () {
    var cache = open();
    var noHash = {
      blogID: "blog_a",
      path: "/a.txt",
      version: "5-1000",
      size: 5,
      sha1: "",
    };

    expect(
      await fs.readFile(await cache.get(noHash, source("hello")), "utf8")
    ).toEqual("hello");
    expect(
      (
        await rejection(
          cache.get(
            Object.assign({}, noHash, { version: "4-1000", size: 4 }),
            source("hello")
          )
        )
      ).code
    ).toEqual("ECHANGED");
  });

  it("rebuilds its recency list from the directory when opened", async function () {
    var first = open({ maxBytes: 8 });

    var a = await first.get(spec("/a.txt", "aaaa"), source("aaaa"));
    var b = await first.get(spec("/b.txt", "bbbb"), source("bbbb"));

    // As if b was used long ago and a recently, by whichever process
    await age(b, 60 * 60 * 1000);
    await age(a, 60 * 1000);

    first.stop();

    var second = open({ maxBytes: 8 });
    await second.ready();

    expect(second.stats()).toEqual(
      jasmine.objectContaining({ entries: 2, bytes: 8 })
    );

    var c = source("cccc");
    await second.get(spec("/c.txt", "cccc"), c);

    expect(await fs.pathExists(a)).toBe(true);
    expect(await fs.pathExists(b)).toBe(false);

    // and a hit on what the first one stored costs no download
    var again = source("aaaa");
    expect(await second.get(spec("/a.txt", "aaaa"), again)).toEqual(a);
    expect(again.calls.count()).toEqual(0);
  });

  it("finds an entry another process stored since its last scan", async function () {
    var one = open();
    var two = open();
    await two.ready();

    var stored = await one.get(spec("/a.txt", "shared"), source("shared"));
    var opener = source("shared");

    expect(await two.get(spec("/a.txt", "shared"), opener)).toEqual(stored);
    expect(opener.calls.count()).toEqual(0);
  });

  it("treats an entry another process evicted as a miss", async function () {
    var cache = open();
    var local = await cache.get(spec("/a.txt", "gone"), source("gone"));

    await fs.remove(join(local, ".."));

    var opener = source("gone");

    expect(
      await fs.readFile(await cache.get(spec("/a.txt", "gone"), opener), "utf8")
    ).toEqual("gone");
    expect(opener.calls.count()).toEqual(1);
  });

  it("clears temporary files a dead process left behind", async function () {
    var abandoned = join(dir, "tmp", "abandoned");
    var recent = join(dir, "tmp", "recent");

    await fs.outputFile(abandoned, "x");
    await fs.outputFile(recent, "x");
    await age(abandoned, 2 * 60 * 60 * 1000);

    await open().ready();

    expect(await fs.pathExists(abandoned)).toBe(false);

    // which may be another process's download in progress
    expect(await fs.pathExists(recent)).toBe(true);
  });

  it("does not evict a pinned entry", async function () {
    var cache = open({ maxBytes: 4 });
    var a;

    await cache.use(
      spec("/a.txt", "aaaa"),
      source("aaaa"),
      async function (local) {
        a = local;

        await cache.get(spec("/b.txt", "bbbb"), source("bbbb"));
        await cache.get(spec("/c.txt", "cccc"), source("cccc"));

        expect(await fs.readFile(local, "utf8")).toEqual("aaaa");
      }
    );

    // Unpinned, it goes like anything else
    await cache.get(spec("/d.txt", "dddd"), source("dddd"));

    expect(await fs.pathExists(a)).toBe(false);
  });

  describe("pinning across processes", function () {
    // Two caches on one directory stand in for two processes. A short grace
    // period keeps the specs quick; the holder touches three times in it.
    var GRACE = 300;

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    // Pins /a.txt in holder, and resolves to { local, release } once fn runs
    async function hold(holder, never) {
      var release;
      var held = new Promise(function (resolve) {
        release = resolve;
      });
      var started = new Promise(function (resolve) {
        holder
          .use(spec("/a.txt", "aaaa"), source("aaaa"), function (local) {
            resolve(local);
            return never ? new Promise(function () {}) : held;
          })
          .catch(function () {});
      });
      var local = await started;

      return { local: local, release: release };
    }

    it("keeps an entry another cache would evict, past the grace period", async function () {
      var holder = open({ maxBytes: 100, graceMs: GRACE });
      var held = await hold(holder);
      var other = open({ maxBytes: 4, graceMs: GRACE });

      await other.ready();
      await sleep(GRACE * 2.5);

      // The other cache last saw it before the wait, and is over budget
      await other.get(spec("/b.txt", "bbbb"), source("bbbb"));
      await other.check();

      expect(await fs.pathExists(held.local)).toBe(true);

      held.release();
    });

    it("lets go of the entry when it is released", async function () {
      var holder = open({ maxBytes: 100, graceMs: GRACE });
      var held = await hold(holder);
      var other = open({ maxBytes: 4, graceMs: GRACE });

      await other.ready();
      await sleep(GRACE * 2.5);
      await other.get(spec("/b.txt", "bbbb"), source("bbbb"));
      expect(await fs.pathExists(held.local)).toBe(true);

      held.release();
      await sleep(GRACE * 1.5);
      await other.get(spec("/c.txt", "cccc"), source("cccc"));

      expect(await fs.pathExists(held.local)).toBe(false);
    });

    it("does not protect an entry whose holder died", async function () {
      var holder = open({ maxBytes: 100, graceMs: GRACE });
      var held = await hold(holder, true);
      var other = open({ maxBytes: 4, graceMs: GRACE });

      await other.ready();

      // The holder goes, with its pin still held and no one to release it
      holder.stop();
      await sleep(GRACE * 1.5);
      await other.get(spec("/b.txt", "bbbb"), source("bbbb"));

      expect(await fs.pathExists(held.local)).toBe(false);
    });

    it("lets the cache run over its budget rather than refuse a fill", async function () {
      var cache = open({ maxBytes: 4, graceMs: GRACE });

      await cache.use(
        spec("/a.txt", "aaaa"),
        source("aaaa"),
        async function () {
          var b = await cache.get(spec("/b.txt", "bbbb"), source("bbbb"));

          expect(await fs.readFile(b, "utf8")).toEqual("bbbb");
          expect(cache.stats().bytes).toBeGreaterThan(4);
        }
      );
    });
  });

  it("gives room back when the disk runs low", async function () {
    var cache = open({ maxBytes: 1000, minFreePercent: 10 });

    await cache.ready();

    var a = await cache.get(spec("/a.txt", "aaaa"), source("aaaa"));
    var b = await cache.get(spec("/b.txt", "bbbb"), source("bbbb"));

    await age(a, 2000);
    await age(b, 1000);

    // 3 bytes short of 10% free: the least recent entry goes, the other stays
    spyOn(require("fs").promises, "statfs").and.callFake(async () => ({
      blocks: 100,
      bavail: 7,
      bsize: 1,
    }));

    await cache.check();

    expect(await fs.pathExists(a)).toBe(false);
    expect(await fs.pathExists(b)).toBe(true);
  });

  describe("put", function () {
    it("stores bytes the caller has, so the next get is a hit", async function () {
      var cache = open();
      var s3 = source("written");

      await cache.put(spec("/a.txt", "written"), source("written"));

      var local = await cache.get(spec("/a.txt", "written"), s3);

      expect(await fs.readFile(local, "utf8")).toEqual("written");
      expect(s3).not.toHaveBeenCalled();
      expect(cache.stats()).toEqual(
        jasmine.objectContaining({
          filled: 1,
          hits: 1,
          misses: 0,
          fetchedBytes: 0,
          entries: 1,
          bytes: 7,
        })
      );
    });

    it("doesn't pass its failure to a get which joined it: the get downloads", async function () {
      var cache = open();
      var s3 = source("written");
      var release;
      var gone = jasmine.createSpy("open").and.callFake(function () {
        return new Promise(function (resolve, reject) {
          release = function () {
            var err = new Error("source removed");
            err.code = "ENOENT";
            reject(err);
          };
        });
      });

      var putting = rejection(cache.put(spec("/a.txt", "written"), gone));

      // Let the put start its fill, so the get joins it
      while (!release) await new Promise(setImmediate);

      var getting = cache.get(spec("/a.txt", "written"), s3);

      await new Promise(setImmediate);
      release();

      expect((await putting).code).toEqual("ENOENT");
      expect(await fs.readFile(await getting, "utf8")).toEqual("written");
      expect(s3).toHaveBeenCalledTimes(1);
    });

    it("leaves an entry which is there already, opening nothing", async function () {
      var cache = open();
      var again = source("same");

      await cache.get(spec("/a.txt", "same"), source("same"));
      await cache.put(spec("/a.txt", "same"), again);

      expect(again).not.toHaveBeenCalled();
      expect(cache.stats()).toEqual(
        jasmine.objectContaining({ filled: 0, entries: 1 })
      );
    });

    it("refuses bytes which are not the version it was given", async function () {
      var cache = open();

      var err = await rejection(
        cache.put(spec("/a.txt", "recorded"), source("changed since"))
      );

      expect(err.code).toEqual("ECHANGED");
      expect(await files()).toEqual([]);

      // Not S3 holding the wrong version, so not counted as that
      expect(cache.stats()).toEqual(
        jasmine.objectContaining({ changed: 0, filled: 0, entries: 0 })
      );
    });

    it("counts towards the budget like any other entry", async function () {
      var cache = open({ maxBytes: 10 });

      // The scan on open would otherwise run alongside the puts
      await cache.ready();

      await cache.put(spec("/a.txt", "aaaa"), source("aaaa"));
      await cache.put(spec("/b.txt", "bbbb"), source("bbbb"));

      expect(cache.stats()).toEqual(
        jasmine.objectContaining({ entries: 2, bytes: 8 })
      );

      await cache.get(spec("/c.txt", "cccc"), source("cccc"));

      expect(cache.stats()).toEqual(
        jasmine.objectContaining({ entries: 2, bytes: 8, evictions: 1 })
      );
    });
  });

  it("removes a blog's entries", async function () {
    var cache = open();

    var a = await cache.get(spec("/a.txt", "a", "blog_a"), source("a"));
    var b = await cache.get(spec("/a.txt", "b", "blog_b"), source("b"));

    await cache.removeBlog("blog_a");

    expect(await fs.pathExists(a)).toBe(false);
    expect(await fs.pathExists(b)).toBe(true);
    expect(cache.stats()).toEqual(
      jasmine.objectContaining({ entries: 1, bytes: 1 })
    );
  });
});
