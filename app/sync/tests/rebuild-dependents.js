describe("rebuild dependents cleanup", function () {
  var rebuildDependents = require("../update/rebuildDependents");
  var Entry = require("models/entry");

  global.test.blog();

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
});
