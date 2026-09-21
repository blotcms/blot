describe("sync", function () {
  var sync = require("../index");

  // A lock held by a dead process is freed by TTL expiry (10s) rather than
  // by the OS, so poll until the next sync can acquire it.
  function syncWhenFree(blogID, callback, deadline) {
    deadline = deadline || Date.now() + 25 * 1000;
    sync(blogID, function (err, folder, done) {
      if (err && Date.now() < deadline) {
        return setTimeout(function () {
          syncWhenFree(blogID, callback, deadline);
        }, 1000);
      }
      callback(err, folder, done);
    });
  }

  // Set up a test blog before each test
  global.test.blog();

  it("acquires a lease for a blog", function (testDone) {
    sync(this.blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      expect(folder.path).toEqual(jasmine.any(String));
      expect(folder.update).toEqual(jasmine.any(Function));
      expect(done).toEqual(jasmine.any(Function));

      done(null, testDone);
    });
  });

  it("will only allow one sync at once", function (testDone) {
    var blog = this.blog;

    sync(blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      sync(blog.id, function (err) {
        expect(err.message).toContain("Failed to acquire folder lock");
        done(null, testDone);
      });
    });
  }, 15 * 1000);

  it(
    "will free the lock when the process dies due to an uncaught exception",
    function (testDone) {
      var child = require("child_process").fork(__dirname + "/error", {
        execArgv: ["--unhandled-rejections=strict"],
        silent: false,
      });
      var blog = this.blog;

      // Did sync release the child's lock on the blog when the child
      // died (was killed)? We test this by trying to acquire a lock.
      child.on("close", function () {
        console.log("CLOSED CALLED! resyncing...");
        syncWhenFree(blog.id, function (err, folder, done) {
          if (err) return testDone.fail(err);
          done(null, testDone);
        });
      });

      console.log("Sending a message to child");
      child.send(blog.id);
    },
    40 * 1000
  );

  it("will free the lock when the process is killed", function (testDone) {
    var child = require("child_process").fork(__dirname + "/kill");
    var blog = this.blog;

    child.send(blog.id);

    // Find out if the child managed to acquire a lock on this blog
    child.on("message", function (message) {
      if (message.error) {
        testDone.fail(message.error);
      } else {
        child.kill();
      }
    });

    // Did sync release the child's lock on the blog when the child
    // died (was killed)? We test this by trying to acquire a lock.
    child.on("close", function () {
      syncWhenFree(blog.id, function (err, folder, done) {
        if (err) return testDone.fail(err);
        done(null, testDone);
      });
    });
  }, 40 * 1000);

  it("will allow you to sync, release and re-sync", function (testDone) {
    var blog = this.blog;

    sync(blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      done(null, function (err) {
        if (err) return testDone.fail(err);

        sync(blog.id, function (err, folder, done) {
          if (err) return testDone.fail(err);

          done(null, testDone);
        });
      });
    });
  });
});

describe("sync folder lock", function () {
  const folderLock = require("../lock");
  const client = require("models/client");

  global.test.blog();

  it("is stored in Redis with a TTL and removed on release", async function () {
    const lock = await folderLock.lock(this.blog.id, { ttl: 5000 });
    const state = await folderLock.inspect(this.blog.id);

    expect(state.held).toBe(true);
    expect(state.holder).toEqual(lock.token);
    expect(state.ttlMs).toBeGreaterThan(0);

    await lock.release();
    expect((await folderLock.inspect(this.blog.id)).held).toBe(false);
  });

  it("rejects with ELOCKED while another holder has it", async function () {
    const lock = await folderLock.lock(this.blog.id);
    let error;
    try {
      await folderLock.lock(this.blog.id);
    } catch (e) {
      error = e;
    }
    expect(error && error.code).toEqual("ELOCKED");
    await lock.release();
  });

  it("does not release a lock it no longer owns", async function () {
    const first = await folderLock.lock(this.blog.id, {
      ttl: 200,
      heartbeat: 60 * 1000,
      onCompromised: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await folderLock.lock(this.blog.id);

    await first.release().catch(() => {});
    expect((await folderLock.inspect(this.blog.id)).holder).toEqual(
      second.token
    );
    await second.release();
  });

  it("heartbeat keeps the lock alive past its TTL", async function () {
    const lock = await folderLock.lock(this.blog.id, {
      ttl: 400,
      heartbeat: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect((await folderLock.inspect(this.blog.id)).holder).toEqual(
      lock.token
    );
    await lock.release();
  });

  it("calls onCompromised when the lock is taken away", async function () {
    const compromised = new Promise((resolve) => {
      folderLock
        .lock(this.blog.id, {
          ttl: 5000,
          heartbeat: 50,
          onCompromised: resolve,
        })
        .then(() => client.del(folderLock.key(this.blog.id)));
    });
    const err = await compromised;
    expect(err.code).toEqual("ECOMPROMISED");
  });
});

describe("sync folder lock release", function () {
  const folderLock = require("../lock");
  const client = require("models/client");

  global.test.blog();

  it("reports compromise when the lock is gone at release", async function () {
    let compromised;
    const lock = await folderLock.lock(this.blog.id, {
      heartbeat: 60 * 1000,
      onCompromised: (err) => (compromised = err),
    });
    await client.del(folderLock.key(this.blog.id));

    let error;
    try {
      await lock.release();
    } catch (e) {
      error = e;
    }
    expect(error && error.code).toEqual("ECOMPROMISED");
    expect(compromised && compromised.code).toEqual("ECOMPROMISED");
  });
});
