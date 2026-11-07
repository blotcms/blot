describe("dependencies", function () {
  var build = require("../index");
  var folder = require("storage/folder");
  var nock = require("nock");
  var sharp = require("sharp");

  global.test.blog();

  var buildEntry = (blog, path) => build(blog, path);

  it("are extracted inside entry contents", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](_foo.jpg)";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.dependencies).toEqual(["/_foo.jpg"]);
  });

  it("are extracted from entry metadata", async function () {
    var path = "/Hello.txt";
    var contents = "Thumbnail: _bar.jpg";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.dependencies).toEqual(["/_bar.jpg"]);
  });

  afterEach(function () {
    nock.cleanAll();
  });

  it("resolves a relative link to a local file", async function () {
    var path = "/Docs/report.txt";
    var contents = "[Download](report.pdf)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/Docs/report.pdf", "fake pdf");

    var entry = await buildEntry(this.blog, path);

    expect(entry.dependencies).toEqual(["/Docs/report.pdf"]);
    // The href is baked into a %%BLOT_CDN%%-prefixed, versioned URL at
    // build time by app/build/plugins/folderAssets, rather than being
    // resolved on every request.
    expect(entry.html).toMatch(
      /href="%%BLOT_CDN%%\/folder\/v-[a-f0-9]{8}\/[^"]*\/Docs\/report\.pdf"/
    );
  });

  it("resolves an image wrapped in a link to the same image", async function () {
    var path = "/Photos/vacation.txt";
    var contents = "[![Beach](beach.jpg)](beach.jpg)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/Photos/beach.jpg", "fake image");

    var entry = await buildEntry(this.blog, path);

    // The link points at a %%BLOT_CDN%%-prefixed, versioned URL for the
    // original file in the folder, baked at build time...
    expect(entry.html).toMatch(
      /href="%%BLOT_CDN%%\/folder\/v-[a-f0-9]{8}\/[^"]*\/Photos\/beach\.jpg"/
    );
    // ...while the image plugin is free to rewrite the <img> src
    // separately (e.g. to a cached/optimized CDN URL); when it doesn't
    // (e.g. the fake image data here isn't a real image), folderAssets
    // still bakes the <img> src too.
    expect(entry.html).toMatch(
      /<a href="%%BLOT_CDN%%\/folder\/v-[a-f0-9]{8}\/[^"]*\/Photos\/beach\.jpg"><img/
    );
  });

  it("does not resolve fragment-only links, e.g. footnotes", async function () {
    var path = "/Post.txt";
    var contents = "Some text.[^1]\n\n[^1]: A footnote.";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    // Footnote refs/backlinks are fragment-only hrefs (e.g.
    // href="#footnote-xyz") - they must stay untouched rather
    // than being resolved into a local file path.
    expect(entry.html).toMatch(/href="#[^"]+"/);
    expect(entry.html).not.toMatch(/href="\/Post\.txt#/);
    expect(entry.dependencies).toEqual([]);
  });

  it("ignores URLs", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](//example.com/_foo.jpg)";

    await folder.write(this.blog.id, path, contents);

    const buffer = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    // The image caching plugin expects a real JPEG payload to proceed.
    nock("http://example.com").get("/_foo.jpg").reply(200, buffer);

    var entry = await buildEntry(this.blog, path);

    expect(entry.dependencies).toEqual([]);
  });
});
