describe("rebuild dependents cleanup", function () {
  var rebuildDependents = require("../update/rebuildDependents");
  var Entry = require("models/entry");
  var client = require("models/client");
  var BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  global.test.blog();

  const getEntry = (blogID, path) => Entry.get(blogID, path);

  const rebuildDependentsOf = (blogID, path) => rebuildDependents(blogID, path);

  it("drops dependents when the source file disappears", async function () {
    const imagePath = "/assets/image.png";
    const postPath = "/post.txt";

    await this.blog.write({
      path: imagePath,
      content: await global.test.fake.pngBuffer(),
    });

    await this.blog.write({
      path: postPath,
      content: `![Alt](${imagePath})`,
    });

    await this.blog.rebuild();

    await this.blog.check({ path: postPath });

    await this.blog.remove(postPath);

    await rebuildDependents(this.blog.id, imagePath);

    const entry = await Entry.get(this.blog.id, postPath);
    expect(entry).toBeDefined();
    expect(entry.deleted).toBe(true);
  });

  it("does not log an error when the dependent was deleted too", async function () {
    const imagePath = "/assets/image.png";
    const postPath = "/post.txt";

    await this.blog.write({
      path: imagePath,
      content: await global.test.fake.pngBuffer(),
    });
    await this.blog.write({ path: postPath, content: `![Alt](${imagePath})` });
    await this.blog.rebuild();
    await this.blog.remove(postPath);

    const logged = [];
    spyOn(console, "log").and.callFake((...args) =>
      logged.push(args.join(" "))
    );

    await rebuildDependentsOf(this.blog.id, imagePath);

    expect(logged.some((line) => line.includes("Error rebuilding"))).toBe(
      false
    );
    expect(
      logged.some((line) => line.includes("Dependent no longer exists"))
    ).toBe(true);
  });

  it("rebuilds a folder post via its source folder instead of dropping it", async function () {
    const assetPath = "/album+/cover.png";
    const sourcePath = "/album+/post.md";

    await this.blog.write({
      path: assetPath,
      content: await global.test.fake.pngBuffer(),
    });

    await this.blog.write({
      path: sourcePath,
      content: `# Cover\n\n![Cover](${assetPath})`,
    });

    await this.blog.rebuild();

    // The aggregate is published at the plus-stripped path.
    await this.blog.check({ path: "/album" });

    const album = await Entry.get(this.blog.id, "/album");
    expect(album.dependencies).toContain(assetPath);

    // Touching the referenced asset triggers a dependent rebuild. This must
    // rebuild the aggregate through /album+, not drop it because /album has
    // no file on disk.
    await rebuildDependents(this.blog.id, assetPath);

    const rebuiltAlbum = await Entry.get(this.blog.id, "/album");
    expect(rebuiltAlbum).toBeDefined();
    expect(rebuiltAlbum.deleted).toBeFalsy();
    expect(rebuiltAlbum.html).toContain('class="multi-file-post"');
  });

  describe("dependents keys", function () {
    const postPath = "/post.txt";

    beforeEach(async function () {
      // Links to a file which doesn't exist yet, in a case it won't have.
      // A plain link rather than an image: the image cache plugin would
      // claim an image before folderAssets sees it.
      await this.blog.write({
        path: postPath,
        content: "Link: /post\n\n[Doc](/Doc.PDF)",
      });
      await this.blog.rebuild();
    });

    it("are lowercased, so a file arriving in another case rebuilds the entry", async function () {
      const key = Entry.key.dependents(this.blog.id, "/Doc.PDF");

      expect(key).toEqual(Entry.key.dependents(this.blog.id, "/doc.pdf"));
      expect(await client.sMembers(key)).toEqual([postPath]);

      await this.blog.write({ path: "/doc.pdf", content: "PDF" });
      await rebuildDependentsOf(this.blog.id, "/doc.pdf");

      expect((await getEntry(this.blog.id, postPath)).html).toContain(
        BLOT_CDN_TOKEN
      );
    });
  });
});
