// Shadow reads of mirrored blog folders (app/storage/folder/shadow.js,
// #2258 Phase C), on MinIO: a sample of storage/folder's reads is repeated
// against the S3 backend once the disk has answered, compared and timed.
describe("storage/folder shadow reads", function () {
  var config = require("config");
  var folder = require("storage/folder");
  var local = require("storage/folder/local");
  var backend = require("storage/folder/s3");
  var shadow = require("storage/folder/shadow");
  var s3 = require("storage/s3");
  var client = require("models/client");
  var report = require("../../../scripts/storage/shadow-report");

  global.test.blog();

  require("./minio")();

  var saved;

  beforeEach(async function () {
    saved = { mirror: config.folder_mirror, shadow: config.folder_shadow };
    config.folder_mirror = this.blog.id;
    config.folder_shadow = { rate: 1, max_in_flight: 4, max_compare_bytes: 1024 * 1024, recheck_ms: 0 };
    shadow.reset();
  });

  afterEach(async function () {
    await shadow.idle();
    config.folder_mirror = saved.mirror;
    config.folder_shadow = saved.shadow;
    shadow.reset();
  });

  // Every read below goes through the facade, as the app's would
  // Each shadow is drained before the next read, so none is dropped at the
  // in-flight cap however slow the runner
  async function readEverything(blogID) {
    var reads = [
      () => folder.read(blogID, "/a.txt"),
      () => folder.stat(blogID, "/a.txt", { sha1: true }),
      () => folder.stat(blogID, "/posts"),
      () => folder.exists(blogID, "/a.txt"),
      () => folder.list(blogID, "/"),
      () => folder.listAll(blogID, "/posts"),
      () => folder.listNames(blogID, "/"),
      () => folder.resolveCaseInsensitive(blogID, "/POSTS/B.md"),
      () => folder.ensureLocal(blogID, "/posts/b.md"),
      () => consume(folder.createReadStream(blogID, "/a.txt", { start: 1, end: 3 })),
    ];

    for (var read of reads) {
      await read();
      await shadow.idle();
    }
  }

  // Resolves once a stream has closed, whether or not it failed
  function drain(stream) {
    return new Promise(function (resolve) {
      stream.on("error", function () {});
      stream.on("close", resolve);
      stream.resume();
    });
  }

  function consume(stream) {
    return new Promise(function (resolve, reject) {
      var chunks = [];
      stream.on("data", function (chunk) {
        chunks.push(chunk);
      });
      stream.on("error", reject);
      // The shadow of a stream starts once it has closed
      stream.on("close", function () {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async function setUp(blogID) {
    await folder.write(blogID, "/a.txt", "hello");
    await folder.write(blogID, "/posts/b.md", "# Title");
  }

  function count(field) {
    return shadow.counters()[field] || 0;
  }

  function fieldsMatching(pattern) {
    return Object.keys(shadow.counters()).filter(function (field) {
      return pattern.test(field);
    });
  }

  it("does nothing at rate 0", async function () {
    config.folder_shadow.rate = 0;

    await setUp(this.blog.id);

    var spies = ["read", "stat", "exists", "list", "listAll", "listNames", "resolveCaseInsensitive", "ensureLocal", "createReadStream"].map(
      function (name) {
        return spyOn(backend, name).and.callThrough();
      }
    );

    await readEverything(this.blog.id);

    spies.forEach(function (spy) {
      expect(spy).not.toHaveBeenCalled();
    });
    expect(shadow.counters()).toEqual({});
  });

  it("does nothing for a blog which is not mirrored", async function () {
    await setUp(this.blog.id);

    config.folder_mirror = "off";

    var spy = spyOn(backend, "read").and.callThrough();

    await folder.read(this.blog.id, "/a.txt");
    await shadow.idle();

    expect(spy).not.toHaveBeenCalled();
    expect(shadow.counters()).toEqual({});
  });

  it("records matches and latencies for reads which agree", async function () {
    await setUp(this.blog.id);
    await readEverything(this.blog.id);

    var ops = { read: 1, stat: 2, exists: 1, list: 1, listAll: 1, listNames: 1, resolveCaseInsensitive: 1, ensureLocal: 1, createReadStream: 1 };

    Object.keys(ops).forEach(function (op) {
      expect(op + " sampled " + count(op + ":sampled")).toEqual(op + " sampled " + ops[op]);
      expect(op + " matched " + count(op + ":matched")).toEqual(op + " matched " + ops[op]);
      expect(fieldsMatching(new RegExp("^" + op + ":local:le:")).length).toBeGreaterThan(0);
      expect(fieldsMatching(new RegExp("^" + op + ":s3:le:")).length).toBeGreaterThan(0);
    });

    expect(fieldsMatching(/:mismatched$|:s3error$|:dropped$/)).toEqual([]);
  });

  it("agrees when neither side has the file", async function () {
    try {
      await folder.read(this.blog.id, "/missing.txt");
      fail("expected NotFoundError");
    } catch (err) {
      expect(err instanceof folder.NotFoundError).toBe(true);
    }

    expect(await folder.exists(this.blog.id, "/missing.txt")).toBe(false);
    await shadow.idle();

    expect(count("read:matched")).toEqual(1);
    expect(count("exists:matched")).toEqual(1);
  });

  it("gives the caller the disk's results unchanged", async function () {
    await setUp(this.blog.id);

    var blogID = this.blog.id;

    expect((await folder.read(blogID, "/a.txt")).equals(await local.read(blogID, "/a.txt"))).toBe(true);
    expect(await folder.stat(blogID, "/a.txt")).toEqual(await local.stat(blogID, "/a.txt"));
    expect(await folder.list(blogID, "/")).toEqual(await local.list(blogID, "/"));
    expect(await folder.listNames(blogID, "/")).toEqual(await local.listNames(blogID, "/"));
    expect(await folder.ensureLocal(blogID, "/a.txt")).toEqual(await local.ensureLocal(blogID, "/a.txt"));
    expect((await consume(folder.createReadStream(blogID, "/a.txt"))).toString()).toEqual("hello");
    await shadow.idle();
  });

  it("detects S3 holding different bytes", async function () {
    await setUp(this.blog.id);

    // Same length, so only the bytes differ; the index still has the old hash
    spyOn(console, "error");
    await s3.putBuffer(this.blog.id + "/folder/a.txt", Buffer.from("hellp"));

    await folder.read(this.blog.id, "/a.txt");
    await consume(folder.createReadStream(this.blog.id, "/a.txt"));
    await shadow.idle();

    expect(count("read:mismatched")).toEqual(1);
    expect(count("read:mismatch:bytes")).toEqual(1);
    expect(count("createReadStream:mismatch:bytes")).toEqual(1);

    var lines = console.error.calls.allArgs().map((args) => args.join(" "));

    expect(
      lines.filter(function (line) {
        return line.indexOf(shadow.LOG_PREFIX) !== -1 && line.indexOf("kind=bytes") !== -1 && line.indexOf("op=read") !== -1;
      }).length
    ).toEqual(1);
  });

  it("detects a file S3 does not have", async function () {
    // Straight to disk, past the mirror
    await local.write(this.blog.id, "/only-on-disk.txt", "here");
    spyOn(console, "error");

    await folder.read(this.blog.id, "/only-on-disk.txt");
    await folder.stat(this.blog.id, "/only-on-disk.txt");
    expect(await folder.exists(this.blog.id, "/only-on-disk.txt")).toBe(true);
    await folder.listNames(this.blog.id, "/");
    await shadow.idle();

    expect(count("read:mismatch:missing-in-s3")).toEqual(1);
    expect(count("stat:mismatch:missing-in-s3")).toEqual(1);
    expect(count("exists:mismatch:missing-in-s3")).toEqual(1);
    expect(count("listNames:mismatch:missing-in-s3") + count("listNames:mismatch:names")).toEqual(1);
  });

  it("counts a mismatch which clears on the recheck as transient", async function () {
    await setUp(this.blog.id);

    var calls = 0;
    var real = backend.read;

    spyOn(backend, "read").and.callFake(function () {
      calls++;
      if (calls === 1) return Promise.resolve(Buffer.from("stale"));
      return real.apply(null, arguments);
    });

    await folder.read(this.blog.id, "/a.txt");
    await shadow.idle();

    expect(count("read:transient")).toEqual(1);
    expect(count("read:transient:bytes")).toEqual(1);
    expect(count("read:mismatched")).toEqual(0);
  });

  it("asks S3's index, not its bytes, about a file missing on disk", async function () {
    config.folder_shadow.max_compare_bytes = 3;

    // Straight to S3, past the disk
    await backend.write(this.blog.id, "/only-in-s3.txt", "hello there");
    spyOn(console, "error");

    var streams = spyOn(backend, "createReadStream").and.callThrough();

    await drain(folder.createReadStream(this.blog.id, "/only-in-s3.txt"));
    await shadow.idle();

    expect(streams).not.toHaveBeenCalled();
    expect(count("createReadStream:mismatch:extra-in-s3")).toEqual(1);
    expect(count("createReadStream:large")).toEqual(0);
  });

  it("counts a recheck which S3 fails as an S3 error, not a mismatch", async function () {
    await setUp(this.blog.id);
    spyOn(console, "error");

    var calls = 0;

    spyOn(backend, "read").and.callFake(function () {
      calls++;
      if (calls === 1) return Promise.resolve(Buffer.from("stale"));
      return Promise.reject(new Error("S3 is down"));
    });

    await folder.read(this.blog.id, "/a.txt");
    await shadow.idle();

    expect(calls).toEqual(2);
    expect(count("read:s3error")).toEqual(1);
    expect(count("read:mismatched")).toEqual(0);
    expect(count("read:transient")).toEqual(0);
  });

  it("counts S3 errors and never passes them to the caller", async function () {
    await setUp(this.blog.id);
    spyOn(console, "error");

    spyOn(backend, "read").and.callFake(function () {
      return Promise.reject(new Error("S3 is down"));
    });
    spyOn(backend, "stat").and.callFake(function () {
      throw new Error("S3 is down");
    });
    spyOn(backend, "createReadStream").and.callFake(function () {
      throw new Error("S3 is down");
    });

    expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("hello");
    expect((await folder.stat(this.blog.id, "/a.txt")).size).toEqual(5);
    expect((await consume(folder.createReadStream(this.blog.id, "/a.txt"))).toString()).toEqual("hello");
    await shadow.idle();

    expect(count("read:s3error")).toEqual(1);
    expect(count("stat:s3error")).toEqual(1);
    expect(count("createReadStream:s3error")).toEqual(1);
    expect(count("read:mismatched")).toEqual(0);
  });

  it("compares the size, not the bytes, of a file over the limit", async function () {
    config.folder_shadow.max_compare_bytes = 3;

    await setUp(this.blog.id);

    var spy = spyOn(backend, "read").and.callThrough();

    await folder.read(this.blog.id, "/a.txt");
    await shadow.idle();

    expect(spy).not.toHaveBeenCalled();
    expect(count("read:large")).toEqual(1);
    expect(count("read:matched")).toEqual(1);
  });

  it("drops samples over the in-flight cap, and counts them", async function () {
    config.folder_shadow.max_in_flight = 1;

    await setUp(this.blog.id);

    var release;
    var real = backend.read;
    var held = new Promise(function (resolve) {
      release = resolve;
    });

    spyOn(backend, "read").and.callFake(async function () {
      await held;
      return real.apply(null, arguments);
    });

    await folder.read(this.blog.id, "/a.txt");
    await folder.read(this.blog.id, "/a.txt");
    await folder.read(this.blog.id, "/a.txt");

    expect(count("read:dropped")).toEqual(2);

    release();
    await shadow.idle();

    expect(count("read:sampled")).toEqual(1);
    expect(count("read:matched")).toEqual(1);
  });

  describe("counters in Redis", function () {
    var keys;

    beforeEach(async function () {
      keys = report.keysFor(2, new Date());
      await client.del(keys);
    });

    afterEach(async function () {
      await client.del(keys);
    });

    it("are flushed to this hour's hash and aggregated by the report", async function () {
      await setUp(this.blog.id);
      await folder.read(this.blog.id, "/a.txt");
      await folder.read(this.blog.id, "/a.txt");
      await folder.exists(this.blog.id, "/missing");
      await shadow.idle();
      await shadow.flush();

      expect(shadow.counters()).toEqual({});

      var key = shadow.hourKey(new Date());
      var hash = await client.hGetAll(key);

      expect(hash["read:sampled"]).toEqual("2");
      expect(await client.ttl(key)).toBeGreaterThan(0);

      // Nothing in Redis names a path
      Object.keys(hash).forEach(function (field) {
        expect(field).not.toMatch(/a\.txt|\/missing/);
      });

      var summary = await report.load(2);

      expect(summary.ops.read.sampled).toEqual(2);
      expect(summary.ops.read.mismatchRate).toEqual(0);
      expect(summary.ops.read.s3.p50).not.toBeNull();
      expect(summary.ops.exists.sampled).toEqual(1);
      // The first read of a.txt misses the content cache, the second hits
      expect(summary.cache.hits + summary.cache.misses).toBeGreaterThan(0);
      expect(report.format(summary)).toContain("read");

      // A second flush adds to the same hash
      await folder.read(this.blog.id, "/a.txt");
      await shadow.idle();
      await shadow.flush();

      expect((await report.load(2)).ops.read.sampled).toEqual(3);
    });
  });
});
