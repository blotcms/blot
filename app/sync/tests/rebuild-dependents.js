describe("rebuild dependents cleanup", function () {
  var rebuildDependents = require("../update/rebuildDependents");
  var Entry = require("models/entry");
  var client = require("models/client");
  var BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  global.test.blog();

  const getEntry = (blogID, path) =>
    new Promise((resolve) => Entry.get(blogID, path, resolve));

  const rebuildDependentsOf = (blogID, path) =>
    new Promise((resolve, reject) =>
      rebuildDependents(blogID, path, (err) => (err ? reject(err) : resolve()))
    );

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

    await new Promise((resolve, reject) => {
      rebuildDependents(this.blog.id, imagePath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await new Promise((resolve) => {
      Entry.get(this.blog.id, postPath, function (entry) {
        expect(entry).toBeDefined();
        expect(entry.deleted).toBe(true);
        resolve();
      });
    });
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

    await new Promise((resolve) => {
      Entry.get(this.blog.id, "/album", function (entry) {
        expect(entry.dependencies).toContain(assetPath);
        resolve();
      });
    });

    // Touching the referenced asset triggers a dependent rebuild. This must
    // rebuild the aggregate through /album+, not drop it because /album has
    // no file on disk.
    await new Promise((resolve, reject) => {
      rebuildDependents(this.blog.id, assetPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await new Promise((resolve) => {
      Entry.get(this.blog.id, "/album", function (entry) {
        expect(entry).toBeDefined();
        expect(entry.deleted).toBeFalsy();
        expect(entry.html).toContain('class="multi-file-post"');
        resolve();
      });
    });
  });

  describe("dependents keys", function () {
    const postPath = "/post.txt";

    beforeEach(async function () {
      // Links to a file which doesn't exist yet, in a case it won't have.
      await this.blog.write({
        path: postPath,
        content: "Link: /post\n\n![Alt](/Photo.JPG)",
      });
      await this.blog.rebuild();
    });

    it("are lowercased, so a file arriving in another case rebuilds the entry", async function () {
      const key = Entry.key.dependents(this.blog.id, "/Photo.JPG");

      expect(key).toEqual(Entry.key.dependents(this.blog.id, "/photo.jpg"));
      expect(await client.sMembers(key)).toEqual([postPath]);

      await this.blog.write({
        path: "/photo.jpg",
        content: await global.test.fake.pngBuffer(),
      });
      await rebuildDependentsOf(this.blog.id, "/photo.jpg");

      expect((await getEntry(this.blog.id, postPath)).html).toContain(
        BLOT_CDN_TOKEN
      );
    });

    it("are still read from the exact-case key until the entry is rebuilt", async function () {
      const key = Entry.key.dependents(this.blog.id, "/Photo.JPG");
      const legacyKey = Entry.key.dependentsExactCase(this.blog.id, "/Photo.JPG");

      expect(legacyKey).not.toEqual(key);

      // How an entry built before keys were lowercased is recorded.
      await client.sRem(key, postPath);
      await client.sAdd(legacyKey, postPath);

      await this.blog.write({
        path: "/photo.jpg",
        content: await global.test.fake.pngBuffer(),
      });
      await rebuildDependentsOf(this.blog.id, "/Photo.JPG");

      expect((await getEntry(this.blog.id, postPath)).html).toContain(
        BLOT_CDN_TOKEN
      );

      // Saving the rebuilt entry moved it to the lowercased key.
      expect(await client.sMembers(legacyKey)).toEqual([]);
      expect(await client.sMembers(key)).toEqual([postPath]);
    });
  });
});
