describe("update when Redis is unavailable", function () {
  var sync = require("../index");
  var fs = require("fs-extra");
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

  it("passes the error on, and the next update applies the change", function (testDone) {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var checkEntry = this.checkEntry;
    var blogID = this.blog.id;

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      callback(writeFreeze());
    });

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      fs.outputFileSync(folder.path + path, content, "utf-8");

      folder.update(path, function (err) {
        expect(isRedisUnavailableError(err)).toBe(true);

        Entry.get(blogID, path, function (entry) {
          expect(entry).toBeFalsy();

          // The freeze is over
          Entry.set.and.callThrough();

          folder.update(path, function (err) {
            if (err) return testDone.fail(err);

            checkEntry({ path: path, deleted: false }, function (err) {
              if (err) return testDone.fail(err);
              done(null, testDone);
            });
          });
        });
      });
    });
  });

  it("passes on a failed drop, and the next update removes the entry", function (testDone) {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var checkEntry = this.checkEntry;
    var blogID = this.blog.id;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      fs.outputFileSync(folder.path + path, content, "utf-8");

      folder.update(path, function (err) {
        if (err) return testDone.fail(err);

        fs.removeSync(folder.path + path);
        spyOn(Entry, "drop").and.callFake(function (blogID, path, callback) {
          callback(writeFreeze());
        });

        folder.update(path, function (err) {
          expect(isRedisUnavailableError(err)).toBe(true);

          checkEntry({ path: path, deleted: false }, function (err) {
            if (err) return testDone.fail(err);

            Entry.drop.and.callThrough();

            folder.update(path, function (err) {
              if (err) return testDone.fail(err);

              checkEntry({ path: path, deleted: true }, function (err) {
                if (err) return testDone.fail(err);
                done(null, testDone);
              });
            });
          });
        });
      });
    });
  });

  it("does not treat a failed read as a missing entry when dropping", function (testDone) {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var checkEntry = this.checkEntry;
    var blogID = this.blog.id;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      fs.outputFileSync(folder.path + path, content, "utf-8");

      folder.update(path, function (err) {
        if (err) return testDone.fail(err);

        fs.removeSync(folder.path + path);
        spyOn(redis, "mGet").and.callFake(function () {
          return Promise.reject(writeFreeze());
        });

        folder.update(path, function (err) {
          expect(isRedisUnavailableError(err)).toBe(true);

          redis.mGet.and.callThrough();

          folder.update(path, function (err) {
            if (err) return testDone.fail(err);

            checkEntry({ path: path, deleted: true }, function (err) {
              if (err) return testDone.fail(err);
              done(null, testDone);
            });
          });
        });
      });
    });
  });

  it("still swallows other errors so one bad file does not stop the sync", function (testDone) {
    var badPath = this.fake.path(".txt");
    var goodPath = this.fake.path(".txt");
    var checkEntry = this.checkEntry;
    var blogID = this.blog.id;
    var realSet = Entry.set;

    spyOn(console, "error");

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      if (path === badPath) return callback(new Error("this file is broken"));
      realSet.apply(Entry, arguments);
    });

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      fs.outputFileSync(folder.path + badPath, this.fake.file(), "utf-8");
      fs.outputFileSync(folder.path + goodPath, this.fake.file(), "utf-8");

      folder.update(badPath, function (err) {
        expect(err).toBeFalsy();

        folder.update(goodPath, function (err) {
          expect(err).toBeFalsy();

          Entry.get(blogID, badPath, function (entry) {
            expect(entry).toBeFalsy();

            checkEntry({ path: goodPath, deleted: false }, function (err) {
              if (err) return testDone.fail(err);
              done(null, testDone);
            });
          });
        });
      });
    }.bind(this));
  });
});
