// S3 as a blog's primary store (app/storage/folder/primary.js, #2258 Phase
// D), on MinIO: the per-blog flag and its guard, the copy of every change to
// disk, the reconcile and the backfill leaving S3 alone for a blog on S3, the
// reverse shadow reads checking it against its disk copy, and
// rebuild-file-index refusing to empty its index under it. The folder's own
// contract is run for a flagged blog in folder.js.
describe("storage/folder primary", function () {
  var config = require("config");
  var crypto = require("crypto");
  var fs = require("fs-extra");
  var { join } = require("path");
  var { Readable } = require("stream");
  var folder = require("storage/folder");
  var local = require("storage/folder/local");
  var backend = require("storage/folder/s3");
  var mirror = require("storage/folder/mirror");
  var primary = require("storage/folder/primary");
  var shadow = require("storage/folder/shadow");
  var s3 = require("storage/s3");
  var client = require("models/client");
  var blogKey = require("models/blog/key");
  var { reconcile } = require("storage/folder/reconcile");
  var backfill = require("../../../scripts/storage/backfill-folder");

  global.test.blog();

  require("./minio")();

  var saved;
  var tmp;

  beforeEach(async function () {
    saved = {
      mirror: config.folder_mirror,
      primary: config.folder_primary,
      shadow: config.folder_shadow,
    };
    config.folder_mirror = "off";
    config.folder_primary = "off";
    await fs.ensureDir(config.tmp_directory);
    tmp = await fs.mkdtemp(join(config.tmp_directory, "folder-primary-"));
  });

  afterEach(async function () {
    config.folder_mirror = saved.mirror;
    config.folder_primary = saved.primary;
    config.folder_shadow = saved.shadow;
    await fs.remove(tmp);
    await client.sRem(mirror.DIRTY_KEY, this.blog.id);
    await client.sRem(primary.DIRTY_KEY, this.blog.id);
    await client.sRem(mirror.COMPLETE_KEY, this.blog.id);
  });

  // Mirrors a folder to S3, marks the copy complete as a clean backfill
  // would, then names the blog
  async function onS3(blogID) {
    config.folder_mirror = blogID;
    await folder.write(blogID, "/a.txt", "a");
    await folder.write(blogID, "/posts/b.md", "# B");
    await client.sAdd(mirror.COMPLETE_KEY, blogID);
    config.folder_primary = blogID;
  }

  // Every path in a backend's copy of the folder, with what a reader sees
  async function tree(store, blogID) {
    var found = {};

    for await (var path of store.walk(blogID, "/", { directories: true })) {
      var stat = await store.stat(blogID, path, { sha1: true });

      found[path] = stat.isDirectory ? "dir" : [stat.size, Math.round(stat.modified), stat.sha1];
    }

    return found;
  }

  async function expectCopied(blogID) {
    expect(await tree(local, blogID)).toEqual(await tree(backend, blogID));
  }

  async function keys(blogID) {
    var found = [];
    for await (var entry of s3.listEntries(backend.root(blogID))) found.push(entry.key.slice(backend.root(blogID).length - 1));
    return found.sort();
  }

  function isDirty(key, blogID) {
    return client.sIsMember(key, blogID).then(Boolean);
  }

  function logged(prefix, blogID) {
    return console.error.calls.allArgs().some(function (args) {
      var line = args.join(" ");
      return line.indexOf(prefix) !== -1 && line.indexOf("blog=" + blogID) !== -1;
    });
  }

  describe("routing", function () {
    it("keeps every blog on disk, without asking Redis, when off", async function () {
      spyOn(primary, "usesS3").and.callThrough();

      await folder.write(this.blog.id, "/a.txt", "a");

      expect(await folder.backendFor(this.blog.id)).toEqual("local");
      expect((await local.read(this.blog.id, "/a.txt")).toString()).toEqual("a");
      expect(await keys(this.blog.id)).toEqual([]);
      expect(primary.usesS3).not.toHaveBeenCalled();
    });

    it("sends a named blog with a copy in S3 to S3", async function () {
      await onS3(this.blog.id);

      expect(await folder.backendFor(this.blog.id)).toEqual("s3");

      // Written to S3 only: the disk's copy comes after
      await backend.write(this.blog.id, "/only-in-s3.txt", "s3");

      expect((await folder.read(this.blog.id, "/only-in-s3.txt")).toString()).toEqual("s3");
      expect(await folder.exists(this.blog.id, "/only-in-s3.txt")).toBe(true);
      expect(await local.exists(this.blog.id, "/only-in-s3.txt")).toBe(false);
    });

    it("routes serve, createReadStream and walk by blog too", async function () {
      await onS3(this.blog.id);
      await backend.write(this.blog.id, "/only-in-s3.txt", "s3");

      var chunks = [];
      for await (var chunk of folder.createReadStream(this.blog.id, "/only-in-s3.txt")) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toEqual("s3");

      var paths = [];
      for await (var path of folder.walk(this.blog.id, "/")) paths.push(path);
      expect(paths).toContain("/only-in-s3.txt");

      var served = {};
      var res = {
        setHeader: function () {},
        sendFile: function (file, options, callback) {
          served.body = fs.readFileSync(file, "utf8");
          callback();
        },
      };

      await folder.serve({ headers: {} }, res, this.blog.id, "/only-in-s3.txt");
      expect(served.body).toEqual("s3");
    });

    it("names only the blogs it lists", async function () {
      await onS3(this.blog.id);

      config.folder_primary = "blog_someoneelse, blog_another";
      expect(await folder.backendFor(this.blog.id)).toEqual("local");

      config.folder_primary = "blog_someoneelse," + this.blog.id;
      expect(await folder.backendFor(this.blog.id)).toEqual("s3");

      config.folder_primary = "all";
      expect(await folder.backendFor(this.blog.id)).toEqual("s3");

      config.folder_primary = "off";
      expect(await folder.backendFor(this.blog.id)).toEqual("local");
    });

    it("keeps every blog on disk without a bucket", async function () {
      var bucket = config.storage.bucket;

      await onS3(this.blog.id);
      spyOn(console, "error");
      config.storage.bucket = "";

      try {
        expect(await folder.backendFor(this.blog.id)).toEqual("local");
      } finally {
        config.storage.bucket = bucket;
      }
    });

    it("rejects a write whose stream fails while the backend is being chosen", async function () {
      config.folder_primary = this.blog.id;

      spyOn(primary, "usesS3").and.callFake(function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(false);
          }, 50);
        });
      });

      var stream = new Readable({ read: function () {} });
      var writing = folder.write(this.blog.id, "/a.txt", stream);

      stream.destroy(new Error("stream failed"));

      var err;

      try {
        await writing;
      } catch (e) {
        err = e;
      }

      expect(err && err.message).toEqual("stream failed");
      expect(await local.exists(this.blog.id, "/a.txt")).toBe(false);
    });

    it("lets a spec's useBackend win over the flag", async function () {
      await onS3(this.blog.id);

      folder.useBackend("local");

      try {
        expect(await folder.backendFor(this.blog.id)).toEqual("local");
      } finally {
        folder.useBackend();
      }

      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
    });
  });

  describe("the guard", function () {
    it("keeps a named blog with no complete copy in S3 on disk", async function () {
      spyOn(console, "log");

      // On disk from before the mirror, never backfilled
      await local.write(this.blog.id, "/a.txt", "a");

      config.folder_mirror = this.blog.id;
      config.folder_primary = this.blog.id;

      expect(await folder.backendFor(this.blog.id)).toEqual("local");
      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("a");
      expect(await keys(this.blog.id)).toEqual([]);
      expect(
        console.log.calls.allArgs().some(function (args) {
          var line = args.join(" ");
          return line.indexOf(primary.LOG_PREFIX) !== -1 && line.indexOf("no complete copy") !== -1;
        })
      ).toBe(true);
    });

    it("keeps a named blog whose mirror has only started its index on disk until its backfill", async function () {
      spyOn(console, "log");

      // On disk from before the mirror
      await local.write(this.blog.id, "/old.txt", "old");

      config.folder_primary = this.blog.id;
      config.folder_mirror = this.blog.id;

      // The mirror's first write starts an index which lacks /old.txt
      await folder.write(this.blog.id, "/a.txt", "a");

      expect(await folder.backendFor(this.blog.id)).toEqual("local");
      expect((await folder.read(this.blog.id, "/old.txt")).toString()).toEqual("old");

      await backfill.run({ blog: this.blog.id, mode: "apply", concurrency: 1, log: function () {} });

      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
      expect((await folder.read(this.blog.id, "/old.txt")).toString()).toEqual("old");
    });

    it("takes a blog out of the complete set when a mirror write fails", async function () {
      await onS3(this.blog.id);
      config.folder_primary = "off";

      spyOn(s3, "putBuffer").and.callFake(function () {
        return Promise.reject(new Error("S3 is down"));
      });
      spyOn(s3, "uploadFile").and.callFake(function () {
        return Promise.reject(new Error("S3 is down"));
      });
      spyOn(console, "error");

      await folder.write(this.blog.id, "/c.txt", "c");

      expect(await isDirty(mirror.COMPLETE_KEY, this.blog.id)).toBe(false);
      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(true);
    });

    it("keeps a blog on S3 when its folder becomes empty", async function () {
      await onS3(this.blog.id);

      await folder.remove(this.blog.id, "/a.txt");
      await folder.rmdir(this.blog.id, "/posts");

      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
      expect(await folder.listAll(this.blog.id, "/")).toEqual([]);
    });

    it("keeps a named blog the mirror doesn't cover on disk", async function () {
      spyOn(console, "log");
      await onS3(this.blog.id);
      config.folder_mirror = "off";

      expect(await folder.backendFor(this.blog.id)).toEqual("local");
    });

    it("keeps a blog whose mirror is dirty on disk", async function () {
      spyOn(console, "log");
      await onS3(this.blog.id);
      await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

      expect(await folder.backendFor(this.blog.id)).toEqual("local");
    });

    it("keeps blogs on the Git client on disk, and lets Local and Google Drive use S3", async function () {
      spyOn(console, "log");
      await onS3(this.blog.id);

      var info = blogKey.info(this.blog.id);
      var before = await client.hGet(info, "client");

      try {
        for (var name of ["git"]) {
          await client.hSet(info, "client", name);
          expect(await folder.backendFor(this.blog.id)).toEqual("local");
        }

        for (var other of ["dropbox", "google-drive", "icloud", "local"]) {
          await client.hSet(info, "client", other);
          expect(await folder.backendFor(this.blog.id)).toEqual("s3");
        }
      } finally {
        await client.hSet(info, "client", before || "");
      }
    });
  });

  describe("the copy on disk", function () {
    beforeEach(async function () {
      await onS3(this.blog.id);
    });

    it("copies every kind of change to disk, with S3's modified times", async function () {
      var blogID = this.blog.id;
      var moved = join(tmp, "moved.txt");
      var copied = join(tmp, "copied.txt");

      await fs.writeFile(moved, "moved in");
      await fs.writeFile(copied, "copied in");

      await folder.write(blogID, "/c.txt", "c");
      await folder.write(blogID, "/stream.bin", Readable.from([crypto.randomBytes(1000), crypto.randomBytes(1000)]));
      await folder.writeFrom(blogID, "/in/moved.txt", moved, { move: true });
      await folder.writeFrom(blogID, "/in/copied.txt", copied);
      await folder.mkdir(blogID, "/empty");
      await folder.move(blogID, "/posts", "/archive");
      await folder.remove(blogID, "/a.txt");

      var staged = await folder.path(blogID, "/out/tool.txt");
      await fs.outputFile(staged, "from a tool");
      await folder.commit(blogID, "/out/tool.txt");

      expect(await fs.pathExists(moved)).toBe(false);
      expect(await local.exists(blogID, "/a.txt")).toBe(false);
      expect((await local.read(blogID, "/archive/b.md")).toString()).toEqual("# B");
      expect((await local.read(blogID, "/out/tool.txt")).toString()).toEqual("from a tool");
      await expectCopied(blogID);
      expect(await isDirty(primary.DIRTY_KEY, blogID)).toBe(false);
    });

    it("removes the disk copy with the blog's folder", async function () {
      await folder.removeAll(this.blog.id);

      expect(await keys(this.blog.id)).toEqual([]);
      expect(await local.exists(this.blog.id, "/a.txt")).toBe(false);
    });

    it("keeps S3's change and marks the blog when the disk fails", async function () {
      spyOn(local, "writeFrom").and.callFake(function () {
        return Promise.reject(new Error("disk is full"));
      });
      spyOn(console, "error");

      await folder.write(this.blog.id, "/c.txt", "in S3");

      expect((await folder.read(this.blog.id, "/c.txt")).toString()).toEqual("in S3");
      expect(await local.exists(this.blog.id, "/c.txt")).toBe(false);
      expect(await isDirty(primary.DIRTY_KEY, this.blog.id)).toBe(true);
      expect(logged("[storage/folder disk copy] failed", this.blog.id)).toBe(true);

      // A dirty disk copy doesn't move the blog off S3
      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
    });

    it("never mirrors a blog on S3, even when the mirror names it", async function () {
      spyOn(s3, "putBuffer").and.callThrough();
      spyOn(s3, "uploadFile").and.callThrough();

      await folder.write(this.blog.id, "/c.txt", "c");

      expect(s3.putBuffer.calls.count()).toEqual(1);
      expect(s3.uploadFile).not.toHaveBeenCalled();
      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(false);
    });
  });

  // A disk copy which has drifted from S3: a file missing, one changed, and
  // one S3 never had
  async function drift(blogID) {
    await local.remove(blogID, "/a.txt");
    await local.write(blogID, "/posts/b.md", "# Changed on disk");
    await local.write(blogID, "/stray.txt", "only on disk");
  }

  describe("the reconcile", function () {
    var email = require("helper/email");
    var sent;

    beforeEach(async function () {
      await onS3(this.blog.id);
      sent = [];
      spyOn(email, "FOLDER_MIRROR_RECONCILE").and.callFake(function (uid, locals, callback) {
        sent.push(locals);
        callback();
      });
    });

    function run(mode) {
      return reconcile({ mode: mode, pauseMs: 0, quietMs: 0 });
    }

    it("repairs the disk of a blog on S3 from S3, and leaves S3 alone", async function () {
      var before = await keys(this.blog.id);
      var index = await tree(backend, this.blog.id);

      await drift(this.blog.id);

      var report = await run("full");

      expect(report.onS3).toEqual([this.blog.id]);
      expect(report.drifted).toEqual([this.blog.id]);
      expect(report.repaired).toEqual([this.blog.id]);
      expect(await keys(this.blog.id)).toEqual(before);
      expect(await tree(backend, this.blog.id)).toEqual(index);
      await expectCopied(this.blog.id);
      expect(sent[0].onS3).toEqual(this.blog.id);
    });

    it("keeps an emptied blog on S3 and empties its disk when the disk copy failed", async function () {
      var blogID = this.blog.id;

      spyOn(local, "remove").and.callFake(function () {
        return Promise.reject(new Error("disk failed"));
      });
      spyOn(console, "error");

      await folder.remove(blogID, "/a.txt");
      await folder.remove(blogID, "/posts");

      local.remove.and.callThrough();

      expect(await isDirty(primary.DIRTY_KEY, blogID)).toBe(true);
      expect(await folder.backendFor(blogID)).toEqual("s3");
      expect(await folder.exists(blogID, "/a.txt")).toBe(false);
      expect(await local.exists(blogID, "/a.txt")).toBe(true);

      var report = await run("dirty");

      expect(report.repaired).toContain(blogID);
      expect(await local.listNames(blogID, "/")).toEqual([]);
      expect(await isDirty(primary.DIRTY_KEY, blogID)).toBe(false);
    });

    it("repairs a blog whose disk copy is dirty", async function () {
      await drift(this.blog.id);
      await client.sAdd(primary.DIRTY_KEY, this.blog.id);

      var report = await run("dirty");

      expect(report.repaired).toContain(this.blog.id);
      expect(await isDirty(primary.DIRTY_KEY, this.blog.id)).toBe(false);
      await expectCopied(this.blog.id);
    });

    it("repairs neither copy of a blog off S3 whose disk copy is behind", async function () {
      var before = await keys(this.blog.id);

      await drift(this.blog.id);
      await client.sAdd(primary.DIRTY_KEY, this.blog.id);
      config.folder_primary = "off";
      spyOn(console, "error");

      var report = await run("dirty");

      expect(report.errored).toEqual([this.blog.id]);
      expect(await keys(this.blog.id)).toEqual(before);
      expect(await local.exists(this.blog.id, "/stray.txt")).toBe(true);
      expect(await isDirty(primary.DIRTY_KEY, this.blog.id)).toBe(true);
      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(false);
    });
  });

  describe("the backfill", function () {
    function quiet() {}

    function run(blogID, mode) {
      return backfill.run({ blog: blogID, mode: mode, concurrency: 1, log: quiet });
    }

    it("restores the disk of a blog on S3, and leaves S3 alone", async function () {
      await onS3(this.blog.id);

      var before = await keys(this.blog.id);
      await drift(this.blog.id);

      var dry = await run(this.blog.id, "dry-run");

      expect(dry.uploads).toEqual(2);
      expect(dry.deletes).toEqual(1);
      expect(await local.exists(this.blog.id, "/stray.txt")).toBe(true);

      await client.sAdd(primary.DIRTY_KEY, this.blog.id);

      var totals = await run(this.blog.id, "apply");

      expect(totals.errors).toEqual(0);
      expect(await keys(this.blog.id)).toEqual(before);
      await expectCopied(this.blog.id);
      expect(await isDirty(primary.DIRTY_KEY, this.blog.id)).toBe(false);
      expect(backfill.exitCode(await run(this.blog.id, "verify"), { mode: "verify" })).toEqual(0);
    });

    it("keeps a named blog on disk until its first backfill has finished", async function () {
      var blogID = this.blog.id;
      var writeFrom = backend.writeFrom;
      var during = [];

      spyOn(console, "log");
      await local.write(blogID, "/a.txt", "a");
      await local.write(blogID, "/b.txt", "b");
      config.folder_mirror = blogID;
      config.folder_primary = blogID;

      spyOn(backend, "writeFrom").and.callFake(function () {
        var args = arguments;
        return folder.backendFor(blogID).then(function (which) {
          during.push(which);
          return writeFrom.apply(backend, args);
        });
      });

      await run(blogID, "apply");

      expect(during).toEqual(["local", "local"]);
      expect(await isDirty(mirror.DIRTY_KEY, blogID)).toBe(false);
      expect(await folder.backendFor(blogID)).toEqual("s3");
    });

    it("refuses a blog off S3 whose disk copy is behind", async function () {
      await onS3(this.blog.id);
      await client.sAdd(primary.DIRTY_KEY, this.blog.id);
      config.folder_primary = "off";

      var totals = await run(this.blog.id, "apply");

      expect(totals.skipped).toEqual([this.blog.id]);
      expect(await isDirty(primary.DIRTY_KEY, this.blog.id)).toBe(true);
    });
  });

  describe("shadow reads", function () {
    var report = require("../../../scripts/storage/shadow-report");

    beforeEach(function () {
      config.folder_shadow = { rate: 1, max_in_flight: 4, max_compare_bytes: 1024 * 1024, recheck_ms: 0 };
      shadow.reset();
    });

    afterEach(async function () {
      await shadow.idle();
      shadow.reset();
    });

    function count(field) {
      return shadow.counters()[field] || 0;
    }

    function fieldsMatching(pattern) {
      return Object.keys(shadow.counters()).filter(function (field) {
        return pattern.test(field);
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

    it("are taken in reverse for a blog on S3, never forward", async function () {
      await onS3(this.blog.id);

      var blogID = this.blog.id;
      var reads = [
        () => folder.read(blogID, "/a.txt"),
        () => folder.stat(blogID, "/a.txt", { sha1: true }),
        () => folder.exists(blogID, "/a.txt"),
        () => folder.list(blogID, "/"),
        () => folder.listNames(blogID, "/"),
        () => folder.listAll(blogID, "/posts"),
        () => folder.resolveCaseInsensitive(blogID, "/POSTS/B.md"),
        () => folder.ensureLocal(blogID, "/posts/b.md"),
        () => consume(folder.createReadStream(blogID, "/a.txt")),
      ];

      // One at a time, so none is dropped at the in-flight cap
      for (var read of reads) {
        await read();
        await shadow.idle();
      }

      var ops = ["read", "stat", "exists", "list", "listNames", "listAll", "resolveCaseInsensitive", "ensureLocal", "createReadStream"];

      ops.forEach(function (op) {
        expect(op + " sampled " + count("reverse:" + op + ":sampled")).toEqual(op + " sampled 1");
        expect(op + " matched " + count("reverse:" + op + ":matched")).toEqual(op + " matched 1");
        expect(count(op + ":sampled")).toEqual(0);
      });

      expect(fieldsMatching(/^reverse:read:s3:le:/).length).toBeGreaterThan(0);
      expect(fieldsMatching(/^reverse:read:local:le:/).length).toBeGreaterThan(0);
      // The caller's own read says how the content cache served it
      expect(fieldsMatching(/^reverse:read:s3:(hit|miss|direct):le:/).length).toEqual(1);
      expect(fieldsMatching(/mismatched$|s3error$|dropped$/)).toEqual([]);
    });

    it("give the caller S3's answer, and detect a disk copy which differs", async function () {
      await onS3(this.blog.id);
      spyOn(console, "error");

      // Straight to S3, past the disk copy: same length, other bytes
      await backend.write(this.blog.id, "/a.txt", "z");
      await backend.write(this.blog.id, "/only-in-s3.txt", "s3");

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("z");
      await shadow.idle();
      expect(await folder.exists(this.blog.id, "/only-in-s3.txt")).toBe(true);
      await shadow.idle();

      expect(count("reverse:read:mismatched")).toEqual(1);
      expect(count("reverse:read:mismatch:bytes")).toEqual(1);
      expect(count("reverse:exists:mismatch:extra-in-s3")).toEqual(1);
      expect(count("read:mismatched")).toEqual(0);

      var lines = console.error.calls.allArgs().map((args) => args.join(" "));

      expect(
        lines.filter(function (line) {
          return line.indexOf(shadow.LOG_PREFIX) !== -1 && line.indexOf("direction=reverse") !== -1 && line.indexOf("kind=bytes") !== -1;
        }).length
      ).toEqual(1);
    });

    it("do not flag a write whose disk copy was still in flight", async function () {
      await onS3(this.blog.id);
      await folder.write(this.blog.id, "/a.txt", "new");

      // The disk copy comes just after S3: the first look at the disk sees
      // the old bytes, the recheck the new ones
      var calls = 0;
      var real = local.read;

      spyOn(local, "read").and.callFake(function () {
        calls++;
        if (calls === 1) return Promise.resolve(Buffer.from("a"));
        return real.apply(null, arguments);
      });

      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toEqual("new");
      await shadow.idle();

      expect(calls).toEqual(2);
      expect(count("reverse:read:transient")).toEqual(1);
      expect(count("reverse:read:transient:size")).toEqual(1);
      expect(count("reverse:read:mismatched")).toEqual(0);
    });

    it("count a mismatch on a disk copy known to be behind as behind, not as a mismatch", async function () {
      await onS3(this.blog.id);
      await backend.write(this.blog.id, "/a.txt", "z");
      await client.sAdd(primary.DIRTY_KEY, this.blog.id);

      await folder.read(this.blog.id, "/a.txt");
      await shadow.idle();

      expect(count("reverse:read:behind")).toEqual(1);
      expect(count("reverse:read:behind:bytes")).toEqual(1);
      expect(count("reverse:read:mismatched")).toEqual(0);
    });

    it("follow reverse_rate when it is set", async function () {
      await onS3(this.blog.id);
      config.folder_shadow.reverse_rate = 0;

      await folder.read(this.blog.id, "/a.txt");
      await shadow.idle();

      expect(shadow.counters()).toEqual({});
    });

    it("are not taken when a spec chose the backend, which leaves no disk copy", async function () {
      folder.useBackend("s3");

      try {
        await folder.write(this.blog.id, "/a.txt", "a");
        await folder.read(this.blog.id, "/a.txt");
        await shadow.idle();
      } finally {
        folder.useBackend();
      }

      expect(shadow.counters()).toEqual({});
    });

    it("are still taken forward for a named blog the guard keeps on disk", async function () {
      await onS3(this.blog.id);
      await client.sAdd(mirror.DIRTY_KEY, this.blog.id);
      spyOn(console, "log");

      await folder.read(this.blog.id, "/a.txt");
      await shadow.idle();

      expect(count("read:sampled")).toEqual(1);
      expect(count("reverse:read:sampled")).toEqual(0);
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

      it("are kept apart by direction, and the report shows each", async function () {
        await onS3(this.blog.id);
        await folder.read(this.blog.id, "/a.txt");
        await shadow.idle();
        await folder.stat(this.blog.id, "/a.txt");
        await shadow.idle();
        await shadow.flush();

        var hash = await client.hGetAll(shadow.hourKey(new Date()));

        expect(hash["reverse:read:sampled"]).toEqual("1");
        expect(hash["read:sampled"]).toBeUndefined();

        var summary = await report.load(2);

        expect(summary.ops.read).toBeUndefined();
        expect(summary.reverse.ops.read.sampled).toEqual(1);
        expect(summary.reverse.ops.read.matched).toEqual(1);
        expect(summary.reverse.ops.stat.sampled).toEqual(1);
        expect(summary.reverse.ops.read.s3.p50).not.toBeNull();
        expect(report.format(summary)).toContain("S3-primary vs disk copy");
      });
    });
  });

  describe("rebuild-file-index", function () {
    var { rebuild } = require("../../../scripts/storage/rebuild-file-index");

    it("rebuilds the index of a blog on disk", async function () {
      config.folder_mirror = this.blog.id;
      await folder.write(this.blog.id, "/a.txt", "a");
      await client.sAdd(mirror.COMPLETE_KEY, this.blog.id);

      var result = await rebuild(this.blog.id, { hash: true });

      expect(result.files).toEqual(1);
      expect(result.viaDisk).toBe(false);
      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(false);
    });

    it("refuses a blog on S3, leaving its index alone", async function () {
      await onS3(this.blog.id);

      var index = await tree(backend, this.blog.id);
      var spy = spyOn(backend, "rebuildIndex").and.callThrough();

      try {
        await rebuild(this.blog.id, { hash: true });
        fail("expected EONS3");
      } catch (err) {
        expect(err.code).toEqual("EONS3");
      }

      expect(spy).not.toHaveBeenCalled();
      expect(await tree(backend, this.blog.id)).toEqual(index);
      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
    });

    it("refuses --via-disk while the disk copy is behind S3", async function () {
      await onS3(this.blog.id);
      await client.sAdd(primary.DIRTY_KEY, this.blog.id);

      try {
        await rebuild(this.blog.id, { hash: true, viaDisk: true, settleMs: 0 });
        fail("expected ECONFLICT");
      } catch (err) {
        expect(err.code).toEqual("ECONFLICT");
      }

      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
    });

    it("with --via-disk, serves the blog from disk meanwhile, and the reconcile puts it back on S3", async function () {
      await onS3(this.blog.id);
      spyOn(console, "log");

      var email = require("helper/email");

      spyOn(email, "FOLDER_MIRROR_RECONCILE").and.callFake(function (uid, locals, callback) {
        callback();
      });

      var seen;
      var real = backend.rebuildIndex;
      var blogID = this.blog.id;

      spyOn(backend, "rebuildIndex").and.callFake(function () {
        var args = arguments;

        // Reads go to the disk copy while the index is rebuilt
        return folder.backendFor(blogID).then(function (which) {
          seen = which;
          return real.apply(null, args);
        });
      });

      var result = await rebuild(this.blog.id, { hash: true, viaDisk: true, settleMs: 0 });

      expect(seen).toEqual("local");
      expect(result.viaDisk).toBe(true);
      expect(result.files).toEqual(2);
      expect(await folder.backendFor(this.blog.id)).toEqual("local");
      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(true);

      await reconcile({ mode: "dirty", pauseMs: 0, quietMs: 0 });

      expect(await isDirty(mirror.DIRTY_KEY, this.blog.id)).toBe(false);
      expect(await folder.backendFor(this.blog.id)).toEqual("s3");
      expect((await folder.read(this.blog.id, "/posts/b.md")).toString()).toEqual("# B");
      await expectCopied(this.blog.id);
    });
  });
});
