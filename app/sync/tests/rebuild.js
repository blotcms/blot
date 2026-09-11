describe("rebuild", function () {
  // Set up a test blog before each test
  global.test.blog();

  it("will rebuild entries on blog", async function (done) {
    const path = "/Hello.txt";

    await this.blog.write({ path, content: "Title: Hello" });
    await this.blog.rebuild();
    await this.blog.check({ path, title: "Hello" });

    await this.blog.write({ path, content: "Title: Bye" });
    await this.blog.rebuild();
    await this.blog.check({ path, title: "Bye" });

    done();
  });

  it("will rebuild cached images on blog", async function (done) {
    const path = "/Hello.txt";

    await this.blog.write({ path, content: "![](_image.png)" });
    await this.blog.write({
      path: "/_image.png",
      content: await global.test.fake.pngBuffer(),
    });
    await this.blog.rebuild();

    const entry = await this.blog.check({ path });

    expect(entry.html).toContain("/_image_cache/");

    await this.blog.rebuild({ imageCache: true });

    const rebuiltEntry = await this.blog.check({ path });

    expect(rebuiltEntry.html).not.toEqual(entry.html);
    expect(entry.thumbnail).toEqual(rebuiltEntry.thumbnail);

    done();
  });

  it("will rebuild entries with dependent files", async function (done) {
    const path = "/Posts/Hello.txt";

    await this.blog.write({ path, content: "![Image](/Public/image.png)" });
    await this.blog.write({
      path: "/Public/image.png",
      content: await global.test.fake.pngBuffer(),
    });

    await this.blog.rebuild();

    const entry = await this.blog.check({ path });

    expect(entry.dependencies).toEqual(["/Public/image.png"]);

    await this.blog.rebuild();
    await this.blog.check({ path });

    done();
  });

  it("will rebuild thumbnails on blog", async function (done) {
    const path = "/Hello.txt";

    await this.blog.write({ path, content: "![](_image.png)" });
    await this.blog.write({
      path: "/_image.png",
      content: await global.test.fake.pngBuffer(),
    });
    await this.blog.rebuild();

    const entry = await this.blog.check({ path });

    expect(entry.html).toContain("/_image_cache/");

    await this.blog.rebuild({ thumbnails: true });

    const rebuiltEntry = await this.blog.check({ path });

    expect(rebuiltEntry.html).toEqual(entry.html);
    expect(entry.thumbnail).not.toEqual(rebuiltEntry.thumbnail);

    done();
  });

  it("keeps a folder post aggregate through a full rebuild", async function (done) {
    const Entry = require("models/entry");
    const { promisify } = require("util");
    const getEntry = (id) =>
      new Promise((resolve) => Entry.get(this.blog.id, id, resolve));

    await this.blog.write({ path: "/essay+/01 intro.md", content: "# Intro" });
    await this.blog.write({ path: "/essay+/02 body.md", content: "The body." });
    await this.blog.rebuild();

    const isAggregate = (html) =>
      html.includes("Intro") && html.includes("body");

    await this.blog.check({ path: "/essay", html: isAggregate });
    await this.blog.check({ path: "/essay+/01 intro.md", ignored: true });

    // A second rebuild with nothing changed must not drop the aggregate — it
    // lives at "/essay" with no file behind it, only the "/essay+" folder.
    await this.blog.rebuild();

    const afterRebuild = await this.blog.check({
      path: "/essay",
      html: isAggregate,
    });
    expect(afterRebuild.deleted).toBeFalsy();

    // And if the aggregate goes missing (e.g. an over-eager ghost sweep), a
    // full rebuild restores it from the "+" folder on disk.
    await promisify(Entry.drop)(this.blog.id, "/essay");
    const dropped = await getEntry("/essay");
    expect(!dropped || dropped.deleted).toBeTruthy();

    await this.blog.rebuild();

    const restored = await this.blog.check({
      path: "/essay",
      html: isAggregate,
    });
    expect(restored.deleted).toBeFalsy();

    done();
  });

  it("drops a folder post aggregate when its + folder is emptied before a rebuild", async function (done) {
    const Entry = require("models/entry");
    const getEntry = (id) =>
      new Promise((resolve) => Entry.get(this.blog.id, id, resolve));

    await this.blog.write({ path: "/essay+/01 intro.md", content: "# Intro" });
    await this.blog.write({ path: "/essay+/02 body.md", content: "The body." });
    await this.blog.rebuild();
    await this.blog.check({ path: "/essay" });

    // Every file leaves the folder but the (now empty) directory stays and no
    // deletion event is processed — only a later full rebuild runs. `walk`
    // only yields files, so the rebuild must still pick up the empty "+" dir.
    await this.blog.remove("/essay+/01 intro.md");
    await this.blog.remove("/essay+/02 body.md");
    await this.blog.rebuild();

    const after = await getEntry("/essay");
    expect(!after || after.deleted).toBeTruthy();

    done();
  });
});
