module.exports = () => {
  const build = require("build");

  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.checkEntry = global.test.CheckEntry(this.blog.id);
    this.syncAndCheck = global.test.SyncAndCheck(this.blog.id);
    this.fake = global.test.fake;
    this.buildAndCheck = ({ path, contents }, expectedEntry, cb) => {
      global.test.folder.writeFiles(this.blog.id, { [path]: contents }).then(() => {
        build(this.blog, path, function (err, entry) {
          for (let key in expectedEntry)
            expect(expectedEntry[key]).toEqual(entry[key]);
          cb();
        });
      }, (err) => {
        fail(err);
        cb();
      });
    };
  });
};
