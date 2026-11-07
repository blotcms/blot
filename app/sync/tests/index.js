describe("sync", function () {
  var sync = require("../index");
  var establishSyncLock = require("../establishSyncLock");

  // A lock held by a dead process is freed by TTL expiry (10s) rather than
  // by the OS, so poll until the next sync can acquire it.
  async function syncWhenFree(blogID) {
    var deadline = Date.now() + 25 * 1000;

    for (;;) {
      try {
        return await sync(blogID, async function () {});
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise(function (resolve) {
          setTimeout(resolve, 1000);
        });
      }
    }
  }

  // Set up a test blog before each test
  global.test.blog();

  it("acquires a lease for a blog", async function () {
    var result = await sync(this.blog.id, async function (folder) {
      expect(folder.update).toEqual(jasmine.any(Function));
      expect(folder.status).toEqual(jasmine.any(Function));
      return "result";
    });

    expect(result).toEqual("result");
  });

  it("rethrows the error the function throws, after releasing the lock", async function () {
    var blogID = this.blog.id;
    var thrown = new Error("boom");

    await expectAsync(
      sync(blogID, async function () {
        throw thrown;
      })
    ).toBeRejectedWith(thrown);

    // The lock was released
    await sync(blogID, async function () {});
  });

  it("rejects when the blog does not exist, without calling the function", async function () {
    var called = false;
    var err;

    try {
      await sync("blog_nonexistent" + Date.now(), async function () {
        called = true;
      });
    } catch (e) {
      err = e;
    }

    expect(err && err.message).toMatch(/^Cannot sync blog /);
    expect(called).toBe(false);
  });

  it("throws a TypeError without a function", function () {
    var blogID = this.blog.id;

    expect(function () {
      sync(blogID);
    }).toThrowError(TypeError);
  });

  it("establishSyncLock resolves the folder and an async done", async function () {
    var blogID = this.blog.id;
    var { folder, done } = await establishSyncLock(blogID);

    expect(folder.update).toEqual(jasmine.any(Function));
    await done(null);

    var thrown = new Error("boom");
    var lock = await establishSyncLock(blogID);
    await expectAsync(lock.done(thrown)).toBeRejectedWith(thrown);

    // The lock was released
    await sync(blogID, async function () {});
  });

  it(
    "will only allow one sync at once",
    async function () {
      var blog = this.blog;
      var err;

      await sync(blog.id, async function () {
        try {
          await sync(blog.id, async function () {});
        } catch (e) {
          err = e;
        }
      });

      expect(err.message).toContain("Failed to acquire folder lock");
    },
    15 * 1000
  );

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
        syncWhenFree(blog.id).then(function () {
          testDone();
        }, testDone.fail);
      });

      console.log("Sending a message to child");
      child.send(blog.id);
    },
    40 * 1000
  );

  it(
    "will free the lock when the process is killed",
    function (testDone) {
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
        syncWhenFree(blog.id).then(function () {
          testDone();
        }, testDone.fail);
      });
    },
    40 * 1000
  );

  it("will allow you to sync, release and re-sync", async function () {
    var blog = this.blog;

    await sync(blog.id, async function () {});
    await sync(blog.id, async function () {});
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

  it("tracks held locks and releaseAll releases them", async function () {
    const before = folderLock.heldCount();
    await folderLock.lock(this.blog.id, { ttl: 5000 });

    expect(folderLock.heldCount()).toBe(before + 1);
    expect((await folderLock.inspect(this.blog.id)).held).toBe(true);

    await folderLock.releaseAll();

    expect(folderLock.heldCount()).toBe(0);
    expect(await client.get(folderLock.key(this.blog.id))).toBe(null);
  });

  it("refuses new locks once drain has stopped acquiring", async function () {
    folderLock.stopAcquiring();
    let error;
    try {
      await folderLock.lock(this.blog.id);
    } catch (e) {
      error = e;
    } finally {
      folderLock.resumeAcquiring();
    }

    expect(error.code).toBe("ELOCKED");
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
    expect((await folderLock.inspect(this.blog.id)).holder).toEqual(lock.token);
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

  describe("heldSince", function () {
    it("returns when the current holder acquired the lock", async function () {
      const before = Date.now();
      const lock = await folderLock.lock(this.blog.id, { ttl: 5000 });
      const since = await folderLock.heldSince(this.blog.id);

      expect(since).toBeGreaterThan(before - 1);
      expect(since).not.toBeGreaterThan(Date.now());

      await lock.release();
    });

    it("returns null when the lock is not held", async function () {
      expect(await folderLock.heldSince(this.blog.id)).toBeNull();
    });

    it("returns null for a lock taken before the timestamp was added", async function () {
      await client.set(
        folderLock.key(this.blog.id),
        "0f8fad5b-d9cb-469f-a165-70867728950e",
        {
          PX: 5000,
        }
      );

      expect(await folderLock.heldSince(this.blog.id)).toBeNull();

      await client.del(folderLock.key(this.blog.id));
    });
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

describe("sync cacheID", function () {
  const sync = require("../index");
  const folderLock = require("../lock");
  const Blog = require("models/blog");
  const storage = require("storage/folder");

  global.test.blog();

  // Changes one file in the blog's folder, then finishes the sync
  function syncChange(blogID) {
    return sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt");
    });
  }

  // Render caches are keyed on cacheID, so skipping the bump leaves the
  // site serving stale pages until something else bumps it
  it("bumps the cacheID even if releasing the lock fails", async function () {
    const blogID = this.blog.id;
    const lock = folderLock.lock;
    const releaseError = new Error(
      "NOREPLICAS Not enough good replicas to write."
    );

    spyOn(folderLock, "lock").and.callFake(async function () {
      const held = await lock.apply(folderLock, arguments);
      const release = held.release;
      held.release = async function () {
        await release();
        throw releaseError;
      };
      return held;
    });
    spyOn(Blog, "bumpCacheID").and.callThrough();

    const before = await Blog.get({ id: blogID });

    await expectAsync(syncChange(blogID)).toBeRejectedWith(releaseError);
    expect(Blog.bumpCacheID).toHaveBeenCalled();

    const after = await Blog.get({ id: blogID });
    expect(after.cacheID).toBeGreaterThan(before.cacheID);
  });

  // Syncs a.txt with these contents, resolving the update's result
  function syncContents(blogID, contents) {
    return sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", Buffer.from(contents));
      return folder.update("/a.txt");
    });
  }

  // A resync (a client reconnecting, say) sends every file again: when each
  // builds exactly the entry already stored, the blog's pages are unchanged
  // and purging them would only make the next visitors wait on a render
  it("leaves the cacheID alone when a sync builds the same entry", async function () {
    const blogID = this.blog.id;

    await syncContents(blogID, "Hello");

    spyOn(Blog, "bumpCacheID").and.callThrough();

    const result = await syncContents(blogID, "Hello");
    expect(result).toEqual({ error: null, changed: false });
    expect(Blog.bumpCacheID).not.toHaveBeenCalled();
  });

  it("bumps the cacheID when a sync changes an entry", async function () {
    const blogID = this.blog.id;

    await syncContents(blogID, "Hello");

    spyOn(Blog, "bumpCacheID").and.callThrough();

    const result = await syncContents(blogID, "Hello, world");
    expect(result.changed).not.toBe(false);
    expect(Blog.bumpCacheID).toHaveBeenCalled();
  });

  // A file which changes while it builds is synced again. The first pass has
  // already stored the new entry, so the second finds it unchanged: the sync
  // must still purge and bump for the change the first pass stored.
  it("bumps the cacheID when a file changed while it built", async function () {
    const blogID = this.blog.id;
    const storage = require("storage/folder");

    await syncContents(blogID, "Hello");

    spyOn(Blog, "bumpCacheID").and.callThrough();

    // The second stat of the path (after the first pass built it) sees a
    // different size, as if the file was written again meanwhile
    const stat = storage.stat;
    let calls = 0;
    spyOn(storage, "stat").and.callFake(async function (id, path) {
      const result = await stat.apply(storage, arguments);
      if (path === "/a.txt" && ++calls === 2)
        return Object.assign({}, result, { size: result.size + 1 });
      return result;
    });

    const result = await syncContents(blogID, "Hello, world");
    expect(calls).toBeGreaterThan(2);
    expect(result.changed).not.toBe(false);
    expect(Blog.bumpCacheID).toHaveBeenCalled();
  });

  // Not every file is an entry: a public file is served from the folder as
  // it is, so it must still purge the pages that cached it
  it("bumps the cacheID when a sync updates a file which is not an entry", async function () {
    const blogID = this.blog.id;

    spyOn(Blog, "bumpCacheID").and.callThrough();

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/_public/style.css", Buffer.from("a{}"));
      await folder.update("/_public/style.css");
    });

    expect(Blog.bumpCacheID).toHaveBeenCalled();
  });

  it("folder.update returns a promise", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      const pending = folder.update("/a.txt");
      expect(typeof pending.then).toBe("function");
      await pending;
    });
  });
});
