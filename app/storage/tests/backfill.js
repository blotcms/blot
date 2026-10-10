describe("storage/backfill", function () {
  global.test.blog();
  global.test.tmp();

  var s3 = require("storage/s3");
  var config = require("config");
  var fs = require("fs-extra");
  var join = require("path").join;
  var { backfill, summarise, failed, isOddKey } = require("storage/backfill");
  var useBucket = require("./minio");

  useBucket();

  var lines;

  // A directory of blogs' assets like blog_static_files_dir
  async function populate(directory) {
    await fs.outputFile(join(directory, "blog_a/_thumbnails/x/small.jpg"), "small");
    await fs.outputFile(join(directory, "blog_a/_avatars/me.png"), "avatar");
    await fs.outputFile(join(directory, "blog_b/_assets/doc/media/one.png"), "one");
    await fs.outputFile(join(directory, "blog_b/_assets/doc/media/two.png"), "two");
    await fs.outputFile(join(directory, "blog_c/_image_cache/c.jpg"), "cached");
    await fs.outputFile(join(directory, "notablog/file.txt"), "ignored");
    await fs.outputFile(join(directory, "stray.txt"), "ignored");
  }

  async function keys() {
    var found = {};
    for await (var entry of s3.listEntries("")) found[entry.key] = entry.size;
    return found;
  }

  async function run(options) {
    lines = [];

    return backfill(
      Object.assign(
        {
          directory: this.directory,
          log: function () {
            lines.push(Array.prototype.join.call(arguments, " "));
          },
        },
        options
      )
    );
  }

  beforeEach(async function () {
    this.directory = join(this.tmp, "static");
    await populate(this.directory);
  });

  it("uploads every file in blog directories and ignores everything else", async function () {
    var stats = await run.call(this);

    expect(stats.uploaded).toEqual(5);
    expect(stats.scanned).toEqual(5);
    expect(stats.blogs).toEqual(3);
    expect(stats.ignored).toEqual(2);
    expect(stats.errors).toEqual(0);
    expect(failed(stats, {})).toBe(false);
    expect(lines.join("\n")).toContain("ignoring 2 entries");

    expect(await keys()).toEqual({
      "blog_a/_avatars/me.png": 6,
      "blog_a/_thumbnails/x/small.jpg": 5,
      "blog_b/_assets/doc/media/one.png": 3,
      "blog_b/_assets/doc/media/two.png": 3,
      "blog_c/_image_cache/c.jpg": 6,
    });

    var object = await s3.head("blog_a/_avatars/me.png");

    expect(object.contentType).toEqual("image/png");
    expect(object.cacheControl).toEqual("public, max-age=31536000, immutable");
  });

  it("uploads only what is missing or a different size", async function () {
    var directory = this.directory;

    await run.call(this);
    await fs.outputFile(join(directory, "blog_a/_avatars/me.png"), "a longer avatar");
    await fs.outputFile(join(directory, "blog_c/_image_cache/new.jpg"), "new");

    var stats = await run.call(this);

    expect(stats.uploaded).toEqual(2);
    expect(stats.missing).toEqual(1);
    expect(stats.mismatched).toEqual(1);
    expect((await keys())["blog_a/_avatars/me.png"]).toEqual(15);

    stats = await run.call(this);

    expect(stats.uploaded).toEqual(0);
    expect(stats.scanned).toEqual(6);
  });

  it("re-uploads a file changed on disk since it was uploaded, even at the same size", async function () {
    var directory = this.directory;
    var file = join(directory, "blog_a/_avatars/me.png");

    await run.call(this);

    // a newer local overwrite of the same size whose upload failed
    await fs.outputFile(file, "AVATAR");
    var future = new Date(Date.now() + 60 * 60 * 1000);
    await fs.utimes(file, future, future);

    var stats = await run.call(this, { verify: true });

    expect(stats.stale).toEqual(1);
    expect(stats.missing + stats.mismatched).toEqual(0);
    expect(stats.bySubdirectory["_avatars"].stale).toEqual(1);
    expect(stats.bySubdirectory["_thumbnails"].stale).toEqual(0);
    expect(failed(stats, { verify: true })).toBe(true);
    expect(summarise(stats, { verify: true })).toContain("Stale in the bucket (changed on disk since): 1");
    expect(stats.uploaded).toEqual(0);

    stats = await run.call(this);

    expect(stats.stale).toEqual(1);
    expect(stats.uploaded).toEqual(1);

    var body = await s3.get("blog_a/_avatars/me.png");
    expect(Buffer.from(await body.Body.transformToByteArray()).toString()).toEqual("AVATAR");
  });

  it("can be limited to one blog or resumed from one", async function () {
    var stats = await run.call(this, { blog: "blog_b" });

    expect(stats.uploaded).toEqual(2);
    expect(Object.keys(await keys()).length).toEqual(2);

    stats = await run.call(this, { from: "blog_b" });

    // blog_b is already complete
    expect(stats.blogs).toEqual(2);
    expect(stats.uploaded).toEqual(1);
    expect(Object.keys(await keys()).sort()).toEqual([
      "blog_b/_assets/doc/media/one.png",
      "blog_b/_assets/doc/media/two.png",
      "blog_c/_image_cache/c.jpg",
    ]);
  });

  it("reports a blog which isn't there as an error", async function () {
    var stats = await run.call(this, { blog: "blog_zzz" });

    expect(stats.errors).toEqual(1);
    expect(failed(stats, {})).toBe(true);
  });

  it("uploads with a concurrency of one", async function () {
    var stats = await run.call(this, { concurrency: 1 });

    expect(stats.uploaded).toEqual(5);
  });

  it("uploads nothing in a dry run, saying what it would", async function () {
    var stats = await run.call(this, { dryRun: true });

    expect(stats.uploaded).toEqual(0);
    expect(stats.missing).toEqual(5);
    expect(await keys()).toEqual({});
    expect(summarise(stats, { dryRun: true })).toContain("Would upload 5 files");
  });

  it("verifies, failing when files are missing or different, by directory", async function () {
    var directory = this.directory;

    await run.call(this, { blog: "blog_a" });
    await run.call(this, { blog: "blog_b" });
    await fs.outputFile(join(directory, "blog_b/_assets/doc/media/one.png"), "bigger than before");

    var stats = await run.call(this, { verify: true });

    expect(stats.uploaded).toEqual(0);
    expect(stats.missing).toEqual(1);
    expect(stats.mismatched).toEqual(1);
    expect(stats.bySubdirectory["_assets"]).toEqual({ scanned: 2, missing: 0, mismatched: 1, stale: 0 });
    expect(stats.bySubdirectory["_image_cache"]).toEqual({ scanned: 1, missing: 1, mismatched: 0, stale: 0 });
    expect(stats.bySubdirectory["_avatars"]).toEqual({ scanned: 1, missing: 0, mismatched: 0, stale: 0 });
    expect(failed(stats, { verify: true })).toBe(true);
    expect(Object.keys(await keys()).length).toEqual(4);

    await run.call(this);
    stats = await run.call(this, { verify: true });

    expect(stats.missing + stats.mismatched + stats.stale).toEqual(0);
    expect(failed(stats, { verify: true })).toBe(false);
  });

  it("lists keys which may not survive a plain URL", async function () {
    var directory = this.directory;
    var odd = [
      "_assets/a+b.png",
      "_assets/100%.png",
      "_assets/a#b.png",
      "_assets/what?.png",
      "_assets/café.png",
      "_assets/ lead.png",
      "_assets/trail .png/x.png",
      "_assets/back\\slash.png",
      "_assets/tab\tname.png",
    ];

    for (var relPath of odd) {
      await fs.outputFile(join(directory, "blog_c", relPath), "x");
    }

    var stats = await run.call(this, { dryRun: true });

    expect(stats.oddKeys.count).toEqual(odd.length - 1);
    expect(stats.oddKeys.keys).not.toContain("blog_c/_assets/trail .png/x.png");
    expect(stats.oddKeys.keys).toContain("blog_c/_assets/a+b.png");
    expect(summarise(stats, { dryRun: true })).toContain("a+b.png");

    expect(isOddKey("blog_c/_image_cache/0a1b-2c3d.jpg")).toBe(false);
    expect(isOddKey("blog_c/_assets/a b.png")).toBe(false);
  });

  it("counts errors and carries on", async function () {
    var directory = this.directory;

    config.assets.endpoint = "http://127.0.0.1:1";
    s3.reset();

    var stats = await run.call(this);

    // one failed listing for each blog
    expect(stats.errors).toEqual(3);
    expect(stats.uploaded).toEqual(0);
    expect(failed(stats, {})).toBe(true);
    expect(await fs.pathExists(join(directory, "blog_a/_avatars/me.png"))).toBe(true);
  }, 30000);

  it("prints progress as it goes", async function () {
    await run.call(this, { progressEvery: 2 });

    expect(lines.filter((line) => /^\[backfill\] blogs=/.test(line)).length).toBeGreaterThan(2);
  });
});
