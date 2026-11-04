describe("sync/hold", function () {
  var hold = require("../hold");
  var sync = require("../index");
  var lock = require("../lock");
  var readOnly = require("helper/readOnly");

  global.test.timeout(60 * 1000);

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

  function trySync(blogID) {
    return new Promise(function (resolve) {
      sync(blogID, function (err, folder, done) {
        if (err) return resolve(err);
        done(null, function () {
          resolve(null);
        });
      });
    });
  }

  it("runs fn holding the lock, so a sync cannot take it, and releases it after", async function () {
    var blogID = this.blog.id;
    var syncError;

    var result = await hold(blogID, async function () {
      expect((await lock.inspect(blogID)).held).toBe(true);
      syncError = await trySync(blogID);
      return "done";
    });

    expect(result).toEqual("done");
    expect(syncError && syncError.message).toEqual("Failed to acquire folder lock");
    expect((await lock.inspect(blogID)).held).toBe(false);

    // And a sync can take it again afterwards
    expect(await trySync(blogID)).toBe(null);
  });

  it("releases the lock when fn throws", async function () {
    var blogID = this.blog.id;
    var err;

    try {
      await hold(blogID, async function () {
        throw new Error("boom");
      });
    } catch (e) {
      err = e;
    }

    expect(err && err.message).toEqual("boom");
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("rejects with ELOCKED when the lock is held, without running fn", async function () {
    var blogID = this.blog.id;
    var held = await lock.lock(blogID);
    var called = false;
    var err;

    try {
      await hold(blogID, async function () {
        called = true;
      });
    } catch (e) {
      err = e;
    } finally {
      await held.release();
    }

    expect(called).toBe(false);
    expect(err && err.code).toEqual("ELOCKED");
  });

  it("waits while the data directory is read-only", async function () {
    var blogID = this.blog.id;
    var called = false;

    await readOnly.enable({ reason: "test", ttl: 100 });

    var finished = hold(blogID, async function () {
      called = true;
    });

    // Longer than the poll interval, so it has checked at least once more
    await wait(2500);

    expect(called).toBe(false);
    expect((await lock.inspect(blogID)).held).toBe(false);

    await readOnly.disable();
    await finished;

    expect(called).toBe(true);
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("holds the lock of a disabled blog", async function () {
    var blogID = this.blog.id;

    await this.blog.update({ isDisabled: true });

    expect(
      await hold(blogID, async function () {
        return (await lock.inspect(blogID)).held;
      })
    ).toBe(true);

    await this.blog.update({ isDisabled: false });
  });

  it("sync counts folder.status and folder.update as progress for the lock", async function () {
    var blogID = this.blog.id;
    var touched = 0;
    var realLock = lock.lock;

    spyOn(lock, "lock").and.callFake(async function () {
      var handle = await realLock.apply(this, arguments);
      var realTouch = handle.touch;
      handle.touch = function () {
        touched++;
        return realTouch.apply(this, arguments);
      };
      return handle;
    });

    await new Promise(function (resolve, reject) {
      sync(blogID, function (err, folder, done) {
        if (err) return reject(err);
        var afterAcquire = touched;
        folder.status("Working");
        var afterStatus = touched;
        folder.update("/does-not-exist.txt", function () {
          try {
            expect(afterAcquire).toBeGreaterThan(0); // the initial "Syncing"
            expect(afterStatus).toBeGreaterThan(afterAcquire);
            expect(touched).toBeGreaterThan(afterStatus);
          } catch (e) {
            return done(null, function () {
              reject(e);
            });
          }
          done(null, resolve);
        });
      });
    });
  });

  it("sync fails a hung sync via the lock's compromise path once there is no progress", async function () {
    var blogID = this.blog.id;
    var realLock = lock.lock;
    var captured;

    spyOn(console, "error");
    hold.defaults.noProgressTimeout = 200;
    spyOn(lock, "lock").and.callFake(function (id, options) {
      captured = options;
      // Don't let the real handler crash the test process
      return realLock.call(this, id, {
        ...options,
        heartbeat: 30,
        onCompromised: function (err) {
          captured.error = err;
        },
      });
    });

    try {
      var handle;
      await new Promise(function (resolve, reject) {
        sync(blogID, function (err, folder, done) {
          if (err) return reject(err);
          handle = done;
          resolve();
        });
      });
      expect(captured.noProgressTimeout).toEqual(200);
      var end = Date.now() + 3000;
      while (!captured.error && Date.now() < end) await wait(20);
      expect(captured.error && captured.error.code).toEqual("ECOMPROMISED");
      // No longer renewed: the TTL (10s) only counts down from here
      var first = (await lock.inspect(blogID)).ttlMs;
      await wait(400);
      var second = (await lock.inspect(blogID)).ttlMs;
      expect(second).toBeLessThan(first - 200);
      await handle(null, function () {});
    } finally {
      hold.defaults.noProgressTimeout = 30 * 60 * 1000;
    }
  });
});
