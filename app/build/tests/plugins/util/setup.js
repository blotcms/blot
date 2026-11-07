module.exports = () => {
  const build = require("build");

  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.checkEntry = global.test.CheckEntry(this.blog.id);
    this.syncAndCheck = global.test.SyncAndCheck(this.blog.id);
    this.fake = global.test.fake;
    this.buildAndCheck = async ({ path, contents }, expectedEntry) => {
      await global.test.folder.writeFiles(this.blog.id, { [path]: contents });
      const entry = await build(this.blog, path);
      for (let key in expectedEntry)
        expect(expectedEntry[key]).toEqual(entry[key]);
    };
  });
};
