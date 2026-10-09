describe("sync while the data directory is read-only", function () {
  var sync = require("../index");
  var lock = require("../lock");
  var readOnly = require("helper/readOnly");

  global.test.timeout(30 * 1000);

  global.test.blog();

  beforeEach(async function () {
    await readOnly.disable();
  });

  // A failing test must not leave the freeze on for other specs
  afterEach(async function () {
    await readOnly.disable();
  });

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  it("waits without taking the folder lock, then completes once the freeze lifts", async function () {
    var blog = this.blog;
    var called = false;
    var result;

    await readOnly.enable({ reason: "test", ttl: 100 });

    var finished = new Promise(function (resolve) {
      sync(blog.id, function (err, folder, done) {
        called = true;
        result = { err: err, folder: folder, done: done };
        resolve();
      });
    });

    // Longer than the poll interval, so it has checked at least once more
    await wait(2500);

    expect(called).toBe(false);
    expect((await lock.inspect(blog.id)).held).toBe(false);

    await readOnly.disable();
    await finished;

    expect(result.err).toBeFalsy();
    expect(result.folder.path).toEqual(jasmine.any(String));
    expect((await lock.inspect(blog.id)).held).toBe(true);

    await new Promise(function (resolve) {
      result.done(null, resolve);
    });

    expect((await lock.inspect(blog.id)).held).toBe(false);
  });

  it("does not wait when writes are allowed", function (testDone) {
    sync(this.blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      expect(folder.path).toEqual(jasmine.any(String));

      done(null, testDone);
    });
  });

  it("lets a sync that already holds the lock finish while the freeze is on", async function () {
    var blog = this.blog;

    var held = await new Promise(function (resolve, reject) {
      sync(blog.id, function (err, folder, done) {
        if (err) return reject(err);
        resolve({ folder: folder, done: done });
      });
    });

    await readOnly.enable({ reason: "test", ttl: 100 });

    // The freeze does not take the lock from a sync that began before it
    expect((await lock.inspect(blog.id)).held).toBe(true);

    await new Promise(function (resolve) {
      held.done(null, resolve);
    });

    expect((await lock.inspect(blog.id)).held).toBe(false);
  });
});
