// A post's first image has its thumbnails made by the sandbox job that resizes
// it (build/plugins/image, build/thumbnail/seed.js), not by a job of their own
describe("build: thumbnails made with the image", function () {
  var build = require("../index");
  var folder = require("storage/folder");
  var assets = require("storage/assets");
  var sandbox = require("sandbox");
  var Transform = require("build/thumbnail/transform");
  var { THUMBNAILS } = require("build/thumbnail/config");
  var fs = require("fs-extra");

  global.test.blog();

  var jobs = function () {
    return sandbox.run.calls.allArgs().map(function (args) {
      return args[0];
    });
  };

  beforeEach(function () {
    spyOn(sandbox, "run").and.callThrough();
    this.write = async (path, contents) => {
      await folder.write(this.blog.id, path, contents);
    };
    this.image = async (path, source) => {
      await folder.writeFrom(this.blog.id, path, source);
    };
  });

  it("makes them in the resize job, with no thumbnail job", async function () {
    await this.write("/post.txt", "![A](small.jpg)");
    await this.image("/small.jpg", __dirname + "/small.jpg");

    var entry = await build(this.blog, "/post.txt");

    expect(Object.keys(entry.thumbnail).sort()).toEqual(
      Object.keys(THUMBNAILS).sort()
    );
    expect(entry.thumbnail.small.name).toEqual("small.jpg");
    expect(entry.thumbnail.square.name).toEqual("square.jpg");
    expect(jobs()).toContain("resize");
    expect(jobs()).not.toContain("thumbnail");

    for (var name of Object.keys(entry.thumbnail))
      expect(
        await assets.exists(this.blog.id, entry.thumbnail[name].path)
      ).toBe(true);
  });

  it("makes the thumbnails the thumbnail job makes of the cached image", async function () {
    await this.write("/post.txt", "![A](small.jpg)");
    await this.image("/small.jpg", __dirname + "/small.jpg");

    var entry = await build(this.blog, "/post.txt");
    var cached = entry.html.match(/_image_cache\/[^"]+/)[0];
    var local = await assets.ensureLocal(
      this.blog.id,
      decodeURIComponent(cached)
    );

    var reply = await sandbox.run(
      "thumbnail",
      Transform.request(".jpg", false),
      { path: local }
    );
    var names = Object.keys(THUMBNAILS);

    expect(reply.outputs.length).toEqual(names.length);

    for (var i = 0; i < names.length; i++) {
      var made = entry.thumbnail[names[i]];
      var stored = await assets.ensureLocal(this.blog.id, made.path);

      expect(made.width).toEqual(reply.meta.thumbnails[i].width);
      expect(made.height).toEqual(reply.meta.thumbnails[i].height);
      expect(fs.readFileSync(stored).equals(reply.outputs[i])).toBe(true);
    }
  });

  it("asks only for the first image's", async function () {
    await this.write("/post.txt", "![A](small.jpg)\n\n![B](other.jpg)");
    await this.image("/small.jpg", __dirname + "/small.jpg");
    await this.image("/other.jpg", __dirname + "/too-small.jpg");

    await build(this.blog, "/post.txt");

    var asked = sandbox.run.calls
      .allArgs()
      .filter((args) => args[0] === "resize")
      .map((args) => !!args[1].thumbnail);

    expect(asked.sort()).toEqual([false, true]);
  });

  it("leaves a thumbnail named in the metadata to the thumbnail job", async function () {
    await this.write("/post.txt", "Thumbnail: small.jpg\n\n![A](small.jpg)");
    await this.image("/small.jpg", __dirname + "/small.jpg");

    var entry = await build(this.blog, "/post.txt");

    expect(entry.thumbnail.small).toBeDefined();
    expect(jobs()).toContain("thumbnail");
    sandbox.run.calls.allArgs().forEach(function (args) {
      if (args[0] === "resize") expect(args[1].thumbnail).toBeUndefined();
    });
  });

  it("rejects an image too small, and carries on to the next", async function () {
    await this.write("/post.txt", "![A](tiny.jpg)\n\n![B](small.jpg)");
    await this.image("/tiny.jpg", __dirname + "/too-small.jpg");
    await this.image("/small.jpg", __dirname + "/small.jpg");

    var entry = await build(this.blog, "/post.txt");

    expect(entry.thumbnail.small).toBeDefined();

    // Only the second image's thumbnails took a job of their own
    expect(jobs().filter((job) => job === "thumbnail").length).toEqual(1);

    sandbox.run.calls.reset();

    // The first image's rejection was stored: building again runs no job
    var again = await build(this.blog, "/post.txt");

    expect(again.thumbnail).toEqual(entry.thumbnail);
    expect(jobs()).not.toContain("thumbnail");
  });

  it("falls back to the thumbnail job if the resize job makes none", async function () {
    var run = sandbox.run.and.callFake(async function (job, args, input) {
      var reply = await require("sandbox/jobs/" + job).run(
        args,
        Buffer.isBuffer(input) ? input : fs.readFileSync(input.path)
      );

      // As a job that couldn't make them answers
      if (job === "resize") {
        delete reply.meta.thumbnail;
        reply.outputs = reply.outputs.slice(0, 1);
      }

      return reply;
    });

    expect(run).toBeDefined();

    await this.write("/post.txt", "![A](small.jpg)");
    await this.image("/small.jpg", __dirname + "/small.jpg");

    var entry = await build(this.blog, "/post.txt");

    expect(entry.thumbnail.small.name).toEqual("small.jpg");
    expect(jobs()).toContain("thumbnail");
  });
});
