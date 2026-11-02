// The scheduled reconcile of the S3 mirror of blog folders
// (app/storage/folder/reconcile.js, #2258 Phase C), on MinIO.
describe("storage/folder reconcile", function () {
  var config = require("config");
  var email = require("helper/email");
  var local = require("storage/folder/local");
  var backend = require("storage/folder/s3");
  var mirror = require("storage/folder/mirror");
  var folderLock = require("sync/lock");
  var client = require("models/client");
  var File = require("models/file");
  var { reconcile } = require("storage/folder/reconcile");

  global.test.blog();

  require("./minio")();

  var saved;
  var sent;

  beforeEach(async function () {
    saved = config.folder_mirror;
    config.folder_mirror = this.blog.id;
    sent = [];

    spyOn(email, "FOLDER_MIRROR_RECONCILE").and.callFake(function (uid, locals, callback) {
      sent.push(locals);
      callback();
    });
  });

  afterEach(async function () {
    config.folder_mirror = saved;
    await client.sRem(mirror.DIRTY_KEY, this.blog.id);
  });

  function run(mode) {
    return reconcile({ mode: mode, pauseMs: 0, quietMs: 0 });
  }

  function isDirty(blogID) {
    return client.sIsMember(mirror.DIRTY_KEY, blogID).then(Boolean);
  }

  // A file on disk which the mirror never saw
  async function unmirrored(blogID) {
    await local.write(blogID, "/a.txt", "a");
    await local.write(blogID, "/posts/b.md", "# B");
  }

  it("does nothing when the mirror is off", async function () {
    config.folder_mirror = "off";
    await unmirrored(this.blog.id);
    await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

    expect(await run("dirty")).toBe(null);
    expect(await run("full")).toBe(null);
    expect(await isDirty(this.blog.id)).toBe(true);
    expect(await File.get(this.blog.id, "/a.txt")).toBe(null);
    expect(sent).toEqual([]);
  });

  it("repairs a dirty blog, takes it out of the dirty set and says so", async function () {
    await unmirrored(this.blog.id);
    await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

    var report = await run("dirty");

    expect(report.repaired).toContain(this.blog.id);
    expect(await isDirty(this.blog.id)).toBe(false);
    expect((await backend.read(this.blog.id, "/posts/b.md")).toString()).toEqual("# B");

    expect(sent.length).toEqual(1);
    expect(sent[0].mode).toEqual("dirty");
    expect(JSON.stringify(sent[0])).not.toContain("b.md");
  });

  it("finds and repairs a blog which differs from its disk", async function () {
    await unmirrored(this.blog.id);

    var report = await run("full");

    expect(report.checked).toEqual(1);
    expect(report.drifted).toEqual([this.blog.id]);
    expect(report.repaired).toEqual([this.blog.id]);
    expect((await backend.read(this.blog.id, "/a.txt")).toString()).toEqual("a");

    expect(sent.length).toEqual(1);
    expect(sent[0].full).toBe(true);
    expect(sent[0].drifted).toEqual(this.blog.id);
  });

  it("sends no email when nothing needed doing", async function () {
    await unmirrored(this.blog.id);
    await run("full");
    sent.length = 0;

    var report = await run("full");

    expect(report.checked).toEqual(1);
    expect(report.drifted).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(sent).toEqual([]);

    expect((await run("dirty")).repaired).not.toContain(this.blog.id);
    expect(sent).toEqual([]);
  });

  it("leaves a locked blog dirty for next time, without an email", async function () {
    await unmirrored(this.blog.id);
    await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

    spyOn(folderLock, "lock").and.callFake(function () {
      var err = new Error("held");
      err.code = "ELOCKED";
      return Promise.reject(err);
    });

    var report = await run("dirty");

    expect(report.locked).toContain(this.blog.id);
    expect(report.repaired).not.toContain(this.blog.id);
    expect(await isDirty(this.blog.id)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("marks a blog dirty when its daily check throws, so the hourly run retries it", async function () {
    await unmirrored(this.blog.id);

    spyOn(require("storage/s3"), "listEntries").and.callFake(async function* () {
      throw new Error("S3 listing failed");
    });
    spyOn(console, "error");

    var report = await run("full");

    expect(report.errored).toContain(this.blog.id);
    expect(await isDirty(this.blog.id)).toBe(true);
  });

  it("keeps a blog dirty and says so when its repair fails", async function () {
    await unmirrored(this.blog.id);
    await client.sAdd(mirror.DIRTY_KEY, this.blog.id);

    spyOn(backend, "writeFrom").and.callFake(function () {
      return Promise.reject(new Error("S3 is down"));
    });

    var report = await run("dirty");

    expect(report.errored).toContain(this.blog.id);
    expect(await isDirty(this.blog.id)).toBe(true);
    expect(sent.length).toEqual(1);
    expect(sent[0].errored).toContain(this.blog.id);
  });

  it("emails a kind of run at most once in the quiet period", async function () {
    await unmirrored(this.blog.id);
    await client.del("notify:folder-mirror-reconcile:full");

    await reconcile({ mode: "full", pauseMs: 0 });
    await local.write(this.blog.id, "/c.txt", "c");
    await reconcile({ mode: "full", pauseMs: 0 });

    expect(sent.length).toEqual(1);

    await client.del("notify:folder-mirror-reconcile:full");
  });
});
