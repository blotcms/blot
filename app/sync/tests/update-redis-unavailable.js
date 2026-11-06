describe("update when Redis is unavailable", function () {
  var sync = require("../index");
  var folder = require("storage/folder");
  var Entry = require("models/entry");
  var redis = require("models/client");
  var { SimpleError } = require("redis");
  var { isRedisUnavailableError } = require("helper/redisUnavailable");

  global.test.timeout(15 * 1000);

  global.test.blog();

  beforeEach(function () {
    this.fake = global.test.fake;
    this.checkEntry = global.test.CheckEntry(this.blog.id);
  });

  // What a host cutover looks like to the app: writes are refused
  function writeFreeze() {
    return new SimpleError("NOREPLICAS Not enough good replicas to write.");
  }

  // Runs fn(syncFolder) while holding the blog's sync lock, then releases it
  function withSync(blogID, fn) {
    return new Promise(function (resolve, reject) {
      sync(blogID, function (err, syncFolder, done) {
        if (err) return reject(err);

        Promise.resolve()
          .then(function () {
            return fn(syncFolder);
          })
          .then(
            function (value) {
              done(null, function () {
                resolve(value);
              });
            },
            function (error) {
              done(null, function () {
                reject(error);
              });
            }
          );
      });
    });
  }

  // Resolves to the error update passed to its callback, or undefined
  function update(syncFolder, path) {
    return new Promise(function (resolve) {
      syncFolder.update(path, function (err) {
        resolve(err);
      });
    });
  }

  function checkEntry(check, spec) {
    return new Promise(function (resolve, reject) {
      check(spec, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  function getEntry(blogID, path) {
    return new Promise(function (resolve) {
      Entry.get(blogID, path, resolve);
    });
  }

  it("passes the error on, and the next update applies the change", async function () {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var check = this.checkEntry;
    var blogID = this.blog.id;

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      callback(writeFreeze());
    });

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content);

      expect(isRedisUnavailableError(await update(syncFolder, path))).toBe(
        true
      );
      expect(await getEntry(blogID, path)).toBeFalsy();

      // The freeze is over
      Entry.set.and.callThrough();

      expect(await update(syncFolder, path)).toBeFalsy();
      await checkEntry(check, { path: path, deleted: false });
    });
  });

  it("passes on a failed drop, and the next update removes the entry", async function () {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var check = this.checkEntry;
    var blogID = this.blog.id;

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content);
      expect(await update(syncFolder, path)).toBeFalsy();

      await folder.remove(blogID, path);
      spyOn(Entry, "drop").and.callFake(function (blogID, path, callback) {
        callback(writeFreeze());
      });

      expect(isRedisUnavailableError(await update(syncFolder, path))).toBe(
        true
      );
      await checkEntry(check, { path: path, deleted: false });

      Entry.drop.and.callThrough();

      expect(await update(syncFolder, path)).toBeFalsy();
      await checkEntry(check, { path: path, deleted: true });
    });
  });

  it("does not treat a failed read as a missing entry when dropping", async function () {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var check = this.checkEntry;
    var blogID = this.blog.id;

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content);
      expect(await update(syncFolder, path)).toBeFalsy();

      await folder.remove(blogID, path);
      spyOn(redis, "mGet").and.callFake(function () {
        return Promise.reject(writeFreeze());
      });

      expect(isRedisUnavailableError(await update(syncFolder, path))).toBe(
        true
      );

      redis.mGet.and.callThrough();

      expect(await update(syncFolder, path)).toBeFalsy();
      await checkEntry(check, { path: path, deleted: true });
    });
  });

  it("still swallows other errors so one bad file does not stop the sync", async function () {
    var badPath = this.fake.path(".txt");
    var goodPath = this.fake.path(".txt");
    var check = this.checkEntry;
    var blogID = this.blog.id;
    var realSet = Entry.set;
    var fake = this.fake;

    spyOn(console, "error");

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      if (path === badPath) return callback(new Error("this file is broken"));
      realSet.apply(Entry, arguments);
    });

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, badPath, fake.file());
      await folder.write(blogID, goodPath, fake.file());

      expect(await update(syncFolder, badPath)).toBeFalsy();
      expect(await update(syncFolder, goodPath)).toBeFalsy();
      expect(await getEntry(blogID, badPath)).toBeFalsy();
      await checkEntry(check, { path: goodPath, deleted: false });
    });
  });
});
