describe("sync while the data directory is read-only", function () {
  var sync = require("../index");
  var establishSyncLock = require("../establishSyncLock");
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
    var finishSync;

    await readOnly.enable({ reason: "test", ttl: 100 });

    var started = new Promise(function (resolve) {
      var finished = sync(blog.id, function (folder) {
        called = true;
        resolve({ folder: folder, finished: finished });
        return new Promise(function (resolve) {
          finishSync = resolve;
        });
      });
    });

    // Longer than the poll interval, so it has checked at least once more
    await wait(2500);

    expect(called).toBe(false);
    expect((await lock.inspect(blog.id)).held).toBe(false);

    await readOnly.disable();
    var result = await started;

    expect(result.folder.update).toEqual(jasmine.any(Function));
    expect((await lock.inspect(blog.id)).held).toBe(true);

    finishSync();
    await result.finished;

    expect((await lock.inspect(blog.id)).held).toBe(false);
  });

  it("does not wait when writes are allowed", async function () {
    await sync(this.blog.id, async function (folder) {
      expect(folder.update).toEqual(jasmine.any(Function));
    });
  });

  it("lets a sync that already holds the lock finish while the freeze is on", async function () {
    var blog = this.blog;

    var held = await establishSyncLock(blog.id);

    await readOnly.enable({ reason: "test", ttl: 100 });

    // The freeze does not take the lock from a sync that began before it
    expect((await lock.inspect(blog.id)).held).toBe(true);

    await held.done(null);

    expect((await lock.inspect(blog.id)).held).toBe(false);
  });
});
