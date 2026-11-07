module.exports = function () {
  const folder = require("storage/folder");
  const eachLimit = require("helper/eachLimit");
  const build = require("build");
  const get = require("../get");
  const set = require("../set");
  const search = require("../search");
  const drop = require("../drop");

  global.test.blog();

  beforeEach(function () {
    this.get = async (path) => get(this.blog.id, path);

    this.search = (query) => search(this.blog.id, query);

    this.drop = async (path) => {
      // Errors are ignored, as they were with the empty callback
      await drop(this.blog.id, path).catch(() => {});
    };

    this.remove = async (path) => {
      await folder.remove(this.blog.id, path);

      // Errors are ignored, as they were with the empty callback
      await drop(this.blog.id, path).catch(() => {});
    };

    this.set = async (path, contents) => {
      await folder.write(this.blog.id, path, contents);

      const entry = await build(this.blog, path);
      await set(this.blog.id, path, entry);
      return get(this.blog.id, path);
    };

    // Build many fixture entries with bounded concurrency. Used by the
    // large-dataset search specs, where the serial `await this.set(...)`
    // loop dominated the runtime. The concurrency cap keeps the shared
    // per-blog bookkeeping in set() (URL assignment, tag/list indexes)
    // from being hammered flat-out. Rejects on the first failure so a
    // spec that expects N indexed entries still sees N.
    this.setMany = async (entries, concurrency = 8) => {
      await eachLimit(entries, concurrency, ({ path, contents }) =>
        this.set(path, contents)
      );
    };
  });
};
