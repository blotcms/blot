describe("scripts/storage/backfill-folder", function () {
  var crypto = require("crypto");
  var fs = require("fs-extra");
  var local = require("storage/folder/local");
  var backend = require("storage/folder/s3");
  var mirror = require("storage/folder/mirror");
  var s3 = require("storage/s3");
  var File = require("models/file");
  var client = require("models/client");
  var folderLock = require("sync/lock");
  var { run, exitCode } = require("../backfill-folder");

  global.test.blog();

  require("../../../app/storage/tests/minio")();

  afterEach(async function () {
    await client.sRem(mirror.DIRTY_KEY, this.blog.id);
  });

  function quiet() {}

  function backfill(blogID, mode) {
    return run({ blog: blogID, mode: mode, concurrency: 1, log: quiet });
  }

  function sha1(data) {
    return crypto.createHash("sha1").update(data).digest("hex");
  }

  async function tree(store, blogID) {
    var found = {};

    for await (var path of store.walk(blogID, "/", { directories: true })) {
      var stat = await store.stat(blogID, path, { sha1: true });

      found[path] = stat.isDirectory ? "dir" : [stat.size, Math.round(stat.modified), stat.sha1];
    }

    return found;
  }

  async function keys(blogID) {
    var found = [];
    for await (var entry of s3.listEntries(blogID + "/folder/")) found.push(entry.key.slice((blogID + "/folder").length));
    return found.sort();
  }

  // A folder on disk with nested files and an empty directory, and a copy in
  // S3 holding a stale file (with its index record) and a stale object the
  // index never heard of
  beforeEach(async function () {
    var blogID = this.blog.id;

    await local.write(blogID, "/a.txt", "a");
    await local.write(blogID, "/posts/2024/b.md", "# B");
    await local.mkdir(blogID, "/empty");
    await backend.write(blogID, "/stale.txt", "gone from disk");
    await s3.putBuffer(blogID + "/folder/orphan/x.txt", "no record");
  });

  it("reports in a dry run and changes nothing", async function () {
    var before = await keys(this.blog.id);
    var totals = await backfill(this.blog.id, "dry-run");

    expect(totals.uploads).toEqual(2);
    expect(totals.bytes).toEqual(4);
    expect(totals.markers).toEqual(1);
    expect(totals.deletes).toEqual(2);
    expect(totals.errors).toEqual(0);
    expect(await keys(this.blog.id)).toEqual(before);
    expect(await File.get(this.blog.id, "/a.txt")).toBe(null);
    expect(exitCode(totals, { mode: "dry-run" })).toEqual(0);
    expect(exitCode(totals, { mode: "verify" })).toEqual(1);
  });

  it("makes S3 and the index match the disk, then has nothing to do", async function () {
    await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

    var totals = await backfill(this.blog.id, "apply");

    expect(totals.errors).toEqual(0);
    expect(totals.skipped).toEqual([]);
    expect(await keys(this.blog.id)).toEqual(["/a.txt", "/empty/", "/posts/2024/b.md"]);
    expect(await tree(backend, this.blog.id)).toEqual(await tree(local, this.blog.id));
    expect((await File.get(this.blog.id, "/posts/2024/b.md")).sha1).toEqual(sha1("# B"));
    expect(await client.sIsMember(mirror.DIRTY_KEY, this.blog.id)).toBeFalsy();

    var again = await backfill(this.blog.id, "verify");

    expect(again.uploads + again.markers + again.deletes + again.retimed).toEqual(0);
    expect(again.hashed).toEqual(0);
    expect(exitCode(again, { mode: "verify" })).toEqual(0);

    var rerun = await backfill(this.blog.id, "apply");

    expect(rerun.uploads + rerun.markers + rerun.deletes + rerun.retimed).toEqual(0);
  });

  it("only corrects the time of a file whose bytes are the same", async function () {
    await backfill(this.blog.id, "apply");

    var then = new Date("2021-06-01T00:00:00Z");
    var file = await local.ensureLocal(this.blog.id, "/a.txt");

    await fs.utimes(file, then, then);

    var totals = await backfill(this.blog.id, "apply");

    expect(totals.uploads).toEqual(0);
    expect(totals.hashed).toEqual(1);
    expect(totals.retimed).toEqual(1);
    expect((await File.get(this.blog.id, "/a.txt")).modified).toEqual(then.getTime());
  });

  it("uploads a file whose bytes changed but whose size did not", async function () {
    await backfill(this.blog.id, "apply");
    await local.write(this.blog.id, "/a.txt", "z");

    var totals = await backfill(this.blog.id, "apply");

    expect(totals.uploads).toEqual(1);
    expect((await backend.read(this.blog.id, "/a.txt")).toString()).toEqual("z");
    expect((await File.get(this.blog.id, "/a.txt")).sha1).toEqual(sha1("z"));
  });

  it("replaces a directory in S3 which is a file on disk, and the other way round", async function () {
    await backfill(this.blog.id, "apply");
    await local.remove(this.blog.id, "/posts");
    await local.write(this.blog.id, "/posts", "now a file");
    await local.remove(this.blog.id, "/a.txt");
    await local.write(this.blog.id, "/a.txt/inner.txt", "now a directory");

    var totals = await backfill(this.blog.id, "apply");

    expect(totals.errors).toEqual(0);
    expect(await tree(backend, this.blog.id)).toEqual(await tree(local, this.blog.id));
    expect(await keys(this.blog.id)).toEqual(["/a.txt/inner.txt", "/empty/", "/posts"]);
  });

  it("backfills a disabled blog", async function () {
    await this.blog.update({ isDisabled: true });

    var totals = await backfill(this.blog.id, "apply");

    await this.blog.update({ isDisabled: false });

    expect(totals.skipped).toEqual([]);
    expect(totals.errors).toEqual(0);
    expect(await keys(this.blog.id)).toEqual(["/a.txt", "/empty/", "/posts/2024/b.md"]);
  });

  it("skips a blog whose sync lock is held", async function () {
    var held = await folderLock.lock(this.blog.id);
    var totals;

    try {
      totals = await backfill(this.blog.id, "apply");
    } finally {
      await held.release();
    }

    expect(totals.skipped).toEqual([this.blog.id]);
    expect(totals.blogs).toEqual(0);
    expect(await File.get(this.blog.id, "/a.txt")).toBe(null);
  }, 60 * 1000);
});
