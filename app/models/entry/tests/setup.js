module.exports = function () {
  const fs = require("fs-extra");
  const async = require("async");
  const build = require("build");
  const get = require("../get");
  const set = require("../set");
  const search = require("../search");
  const drop = require("../drop");

  global.test.blog();

  beforeEach(function () {
    this.get = async path => {
      return new Promise(resolve => {
        get(this.blog.id, path, entry => {
          resolve(entry);
        });
      });
    };

    this.search = async query => {
      return new Promise((resolve, reject) => {
        search(this.blog.id, query, (err, ids) => {
          if (err) reject(err);
          else resolve(ids);
        });
      });
    };

    this.drop = async path => {
      return new Promise(resolve => {
        drop(this.blog.id, path, () => {
          resolve();
        });
      });
    };

    this.remove = async path => {
      return new Promise((resolve, reject) => {
        fs.remove(this.blogDirectory + path, err => {
          if (err) reject(err);
          drop(this.blog.id, path, () => {
            resolve();
          });
        });
      });
    };

    this.set = async (path, contents) => {
      return new Promise((resolve, reject) => {
        fs.outputFileSync(this.blogDirectory + path, contents);
        build(this.blog, path, (err, entry) => {
          if (err) return reject(err);
          set(this.blog.id, path, entry, err => {
            if (err) return reject(err);
            get(this.blog.id, path, entry => {
              resolve(entry);
            });
          });
        });
      });
    };

    // Build many fixture entries with bounded concurrency. Used by the
    // large-dataset search specs, where the serial `await this.set(...)`
    // loop dominated the runtime. The concurrency cap keeps the shared
    // per-blog bookkeeping in set() (URL assignment, tag/list indexes)
    // from being hammered flat-out. Rejects on the first failure so a
    // spec that expects N indexed entries still sees N.
    this.setMany = async (entries, concurrency = 8) => {
      await new Promise((resolve, reject) => {
        async.eachLimit(
          entries,
          concurrency,
          ({ path, contents }, next) => {
            this.set(path, contents).then(() => next(), next);
          },
          err => (err ? reject(err) : resolve())
        );
      });
    };
  });
};
