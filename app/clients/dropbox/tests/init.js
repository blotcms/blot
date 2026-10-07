describe("dropbox init", function () {
  const { INSUFFICIENT_SPACE_ERROR_CODE, transferIncomplete } = require("../util/constants");

  describe("transferIncomplete", function () {
    it("is true when transfer_pending is true", function () {
      expect(transferIncomplete({ error_code: 0, transfer_pending: true })).toEqual(true);
    });

    it("is true for the insufficient-space error code, even without transfer_pending", function () {
      // Covers accounts written before transfer_pending existed.
      expect(
        transferIncomplete({ error_code: INSUFFICIENT_SPACE_ERROR_CODE })
      ).toEqual(true);
    });

    it("is false once transfer_pending is false and error_code is 0", function () {
      expect(
        transferIncomplete({ error_code: 0, transfer_pending: false })
      ).toEqual(false);
    });

    it("is false for other error codes, no error, or a missing account", function () {
      expect(transferIncomplete({ error_code: 401 })).toEqual(false);
      expect(transferIncomplete({ error_code: 409 })).toEqual(false);
      expect(transferIncomplete(null)).toEqual(false);
      expect(transferIncomplete(undefined)).toEqual(false);
    });
  });

  // resyncRecentSyncsOnStartup (server boot) and validateAllBlogs (hourly
  // job) must never reach resetToBlotWithLock for a blog whose transfer is
  // incomplete, since resetToBlot would treat the files that never got
  // uploaded as "deleted on Dropbox" and remove them from Blot - the exact
  // data loss this whole change guards against. These tests stand a single
  // blog up as the only blog in the system for each of the two ways an
  // account can be "incomplete" (a stale error_code: 507 from before
  // transfer_pending existed, and a plain interrupted-transfer account with
  // transfer_pending: true and error_code: 0), so if either function's skip
  // check regresses, this blog is the one whose folder would get resynced
  // and the resetToBlot stub below would be called.
  describe("skips a blog with an incomplete transfer", function () {
    const blogPath = require.resolve("models/blog");
    const databasePath = require.resolve("../database");
    const resetToBlotPath = require.resolve("../sync/reset-to-blot");
    const initPath = require.resolve("../init");

    const blogID = "blog_incompletetransfertest" + Date.now();
    const originals = {};

    beforeEach(function () {
      [blogPath, databasePath, resetToBlotPath, initPath].forEach(
        (path) => (originals[path] = require.cache[path])
      );
    });

    afterEach(function () {
      [blogPath, databasePath, resetToBlotPath, initPath].forEach((path) => {
        if (originals[path]) require.cache[path] = originals[path];
        else delete require.cache[path];
      });
    });

    function load(account) {
      require.cache[blogPath] = {
        exports: {
          getAllIDs: function (callback) {
            callback(null, [blogID]);
          },
          get: function (query, callback) {
            callback(null, {
              id: blogID,
              handle: "incomplete-transfer-blog",
              client: "dropbox",
            });
          },
        },
      };
      require.cache[databasePath] = {
        exports: {
          get: function (_blogID, callback) {
            callback(null, account);
          },
          set: function (_blogID, _values, callback) {
            callback(null);
          },
        },
      };
      require.cache[resetToBlotPath] = {
        exports: function () {
          throw new Error(
            "resetToBlot should never be called for a blog with an incomplete transfer"
          );
        },
      };
      delete require.cache[initPath];
      return require("../init");
    }

    const scenarios = {
      "the legacy out-of-space error code": {
        error_code: INSUFFICIENT_SPACE_ERROR_CODE,
        last_sync: Date.now(),
      },
      "transfer_pending, with no error code": {
        error_code: 0,
        transfer_pending: true,
        last_sync: Date.now(),
      },
    };

    Object.keys(scenarios).forEach((description) => {
      const account = scenarios[description];

      it(
        "resyncRecentSyncsOnStartup skips it (" + description + ")",
        async function () {
          const init = load(account);
          // Throws (failing the test) if resetToBlot ever gets invoked.
          await init.resyncRecentSyncsOnStartup();
        }
      );

      it(
        "validateAllBlogs skips it (" + description + ")",
        async function () {
          const init = load(account);
          await init.validateAllBlogs();
        }
      );
    });
  });

  // The authoritative guard now lives in sync/reset-to-blot.js itself (it
  // throws a DROPBOX_TRANSFER_INCOMPLETE-coded error right after loading the
  // account, before touching anything) so that every caller is covered, not
  // just the ones that remember to check first - see its own guard spec in
  // tests/reset-to-blot.js. This means resetToBlotWithLock doesn't need to
  // re-read the account itself: it just needs to recognize that error and
  // translate it into the TRANSFER_INCOMPLETE sentinel its callers expect,
  // rather than treating it as a real failure.
  describe("resetToBlotWithLock", function () {
    const resetToBlotPath = require.resolve("../sync/reset-to-blot");
    const lockPath = require.resolve("sync/establishSyncLock");
    const initPath = require.resolve("../init");

    const blogID = "blog_lockwrappertest" + Date.now();
    const originals = {};

    beforeEach(function () {
      [resetToBlotPath, lockPath, initPath].forEach(
        (path) => (originals[path] = require.cache[path])
      );
    });

    afterEach(function () {
      [resetToBlotPath, lockPath].forEach((path) => {
        if (originals[path]) require.cache[path] = originals[path];
        else delete require.cache[path];
      });
      delete require.cache[initPath];
      if (originals[initPath]) require.cache[initPath] = originals[initPath];
    });

    function load(resetToBlotBehavior) {
      require.cache[resetToBlotPath] = {
        exports: resetToBlotBehavior,
      };
      require.cache[lockPath] = {
        exports: function () {
          return Promise.resolve({
            folder: {
              update: function (path, cb) {
                cb(null);
              },
            },
            done: async function () {},
          });
        },
      };
      delete require.cache[initPath];
      return require("../init");
    }

    it("returns the TRANSFER_INCOMPLETE sentinel (not a rejection) when resetToBlot refuses", async function () {
      const init = load(function () {
        const error = new Error("Dropbox hasn't finished receiving this blog's initial transfer yet");
        error.code = "DROPBOX_TRANSFER_INCOMPLETE";
        return Promise.reject(error);
      });

      const result = await init.resetToBlotWithLock(blogID, () => {});

      expect(result).toEqual(init.TRANSFER_INCOMPLETE);
    });

    it("returns the summary when resetToBlot succeeds", async function () {
      const init = load(function () {
        return Promise.resolve({ downloaded: 1 });
      });

      const result = await init.resetToBlotWithLock(blogID, () => {});

      expect(result).toEqual({ downloaded: 1 });
    });

    it("rethrows any other error from resetToBlot", async function () {
      const init = load(function () {
        return Promise.reject(new Error("some other failure"));
      });

      let error;
      try {
        await init.resetToBlotWithLock(blogID, () => {});
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error.message).toEqual("some other failure");
    });
  });

  // End-to-end versions of the same thing, through validateAllBlogs and
  // resyncRecentSyncsOnStartup: resetToBlot (stubbed here to simulate its
  // real guard) refuses, and neither caller should treat that as a failure -
  // no thrown/uncaught error, no fixBlog/catchUpSync follow-up, no issue
  // reported.
  describe("skips a blog when resetToBlot itself refuses mid-run", function () {
    const blogPath = require.resolve("models/blog");
    const databasePath = require.resolve("../database");
    const resetToBlotPath = require.resolve("../sync/reset-to-blot");
    const lockPath = require.resolve("sync/establishSyncLock");
    const initPath = require.resolve("../init");

    const blogID = "blog_refusedmidrun" + Date.now();
    const originals = {};

    beforeEach(function () {
      [blogPath, databasePath, resetToBlotPath, lockPath, initPath].forEach(
        (path) => (originals[path] = require.cache[path])
      );
    });

    afterEach(function () {
      [blogPath, databasePath, resetToBlotPath, lockPath].forEach((path) => {
        if (originals[path]) require.cache[path] = originals[path];
        else delete require.cache[path];
      });
      delete require.cache[initPath];
      if (originals[initPath]) require.cache[initPath] = originals[initPath];
    });

    function load(onResetToBlotCalled) {
      require.cache[blogPath] = {
        exports: {
          getAllIDs: function (callback) {
            callback(null, [blogID]);
          },
          get: function (query, callback) {
            callback(null, { id: blogID, handle: "refused-blog", client: "dropbox" });
          },
        },
      };
      require.cache[databasePath] = {
        exports: {
          // The outer pre-check sees a complete transfer - resetToBlot
          // itself is the one that refuses, as if the transfer became
          // incomplete in the time it took to acquire the lock.
          get: function (_blogID, callback) {
            callback(null, {
              error_code: 0,
              transfer_pending: false,
              last_sync: Date.now(),
            });
          },
          set: function (_blogID, _values, callback) {
            callback(null);
          },
        },
      };
      require.cache[resetToBlotPath] = {
        exports: function () {
          if (onResetToBlotCalled) onResetToBlotCalled();
          const error = new Error("refused");
          error.code = "DROPBOX_TRANSFER_INCOMPLETE";
          return Promise.reject(error);
        },
      };
      require.cache[lockPath] = {
        exports: function () {
          return Promise.resolve({
            folder: {
              update: function (path, cb) {
                cb(null);
              },
            },
            done: async function () {},
          });
        },
      };
      delete require.cache[initPath];
      return require("../init");
    }

    it("validateAllBlogs completes without throwing", async function () {
      const init = load();
      await init.validateAllBlogs();
    });

    it("resyncRecentSyncsOnStartup completes without throwing", async function () {
      // The actual resync work runs inside an un-awaited setImmediate (see
      // resyncRecentSyncsOnStartup), so wait for resetToBlot to actually be
      // called before asserting, rather than trusting the outer function's
      // own promise to have done all the work.
      let resolveCalled;
      const called = new Promise((resolve) => {
        resolveCalled = resolve;
      });

      const init = load(resolveCalled);

      await init.resyncRecentSyncsOnStartup();
      await called;
      // Let the rest of the (all-stubbed, no real I/O) promise chain after
      // resetToBlot rejects - resetToBlotWithLock catching it, the loop's
      // continue - actually run before the test ends.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  // One digest per sweep: changes, Fix() repairs, errors and a stuck lock for
  // different blogs all land in the same DROPBOX_SYNC_ISSUE email, and blogs
  // with nothing wrong (or a briefly busy lock) don't appear in it.
  describe("validateAllBlogs digest", function () {
    const paths = {
      blog: require.resolve("models/blog"),
      database: require.resolve("../database"),
      resetToBlot: require.resolve("../sync/reset-to-blot"),
      lock: require.resolve("sync/establishSyncLock"),
      folderLock: require.resolve("sync/lock"),
      fix: require.resolve("sync/fix"),
      sync: require.resolve("../sync"),
      email: require.resolve("helper/email"),
      getHealth: require.resolve("../getHealth"),
      redis: require.resolve("models/client"),
      init: require.resolve("../init"),
    };
    const originals = {};
    const HOUR = 60 * 60 * 1000;
    // What the digest remembers having reported (see syncReport), as a
    // fake of the Redis set it lives in. Kept across sweeps within a test.
    let reported;
    let walked;

    beforeEach(function () {
      reported = new Set();
      walked = [];
      Object.keys(paths).forEach((name) => {
        originals[name] = require.cache[paths[name]];
      });
    });

    afterEach(function () {
      Object.keys(paths).forEach((name) => {
        if (originals[name]) require.cache[paths[name]] = originals[name];
        else delete require.cache[paths[name]];
      });
    });

    const stub = (name, exports) => {
      require.cache[paths[name]] = {
        id: paths[name],
        filename: paths[name],
        loaded: true,
        exports,
      };
    };

    // behaviors: { [blogID]: { summary, walkError, busy, heldSince, lastSync,
    // fixReport, fixError, syncError, health } }. health is a getHealth
    // result, an Error to throw, or a function of how many times the blog's
    // health has been read (a blog's folder can vanish mid-sweep).
    function load(behaviors, sentEmails) {
      const healthReads = {};

      const ids = Object.keys(behaviors);

      stub("blog", {
        getAllIDs: (callback) => callback(null, ids),
        get: ({ id }, callback) =>
          callback(null, { id, handle: id + "-handle", client: "dropbox" }),
      });
      stub("database", {
        get: (_id, callback) =>
          callback(null, {
            error_code: 0,
            transfer_pending: false,
            last_sync: behaviors[_id].lastSync || Date.now(),
          }),
        set: (_id, _values, callback) => callback(null),
      });
      stub("lock", function (blogID) {
        if (behaviors[blogID].busy) {
          return Promise.reject(new Error("Failed to acquire folder lock"));
        }
        return Promise.resolve({
          folder: { update: (path, cb) => cb(null) },
          done: async function () {},
        });
      });
      stub("resetToBlot", function (blogID) {
        const behavior = behaviors[blogID];
        walked.push(blogID);
        if (behavior.walkError) return Promise.reject(behavior.walkError);
        return Promise.resolve(behavior.summary || {});
      });
      stub("folderLock", {
        heldSince: async (blogID) => behaviors[blogID].heldSince || null,
      });
      stub("fix", function (blog, callback) {
        const behavior = behaviors[blog.id];
        callback(behavior.fixError || null, behavior.fixReport || {});
      });
      stub("sync", function (blog, callback) {
        callback(behaviors[blog.id].syncError || null);
      });
      stub("getHealth", async function (blogID) {
        const health = require("clients/health");
        let result = behaviors[blogID].health || health.ok();
        healthReads[blogID] = (healthReads[blogID] || 0) + 1;
        if (typeof result === "function") result = result(healthReads[blogID]);
        if (result instanceof Error) throw result;
        return result;
      });
      stub("redis", {
        sMembers: async () => Array.from(reported),
        multi: function () {
          const ops = [];
          const multi = {
            del: () => (ops.push(() => reported.clear()), multi),
            sAdd: (key, ids) => (
              ops.push(() => ids.forEach((id) => reported.add(id))), multi
            ),
            exec: async () => ops.forEach((op) => op()),
          };
          return multi;
        },
      });
      stub("email", {
        DROPBOX_SYNC_ISSUE: function (uid, locals, callback) {
          sentEmails.push(locals);
          callback();
        },
      });
      delete require.cache[paths.init];
      return require("../init");
    }

    const stamp = Date.now();
    const ids = {
      changes: "blog_digestchanges" + stamp,
      repaired: "blog_digestrepaired" + stamp,
      walkError: "blog_digestwalkerror" + stamp,
      fixError: "blog_digestfixerror" + stamp,
      syncError: "blog_digestsyncerror" + stamp,
      stuck: "blog_digeststuck" + stamp,
      briefly: "blog_digestbriefly" + stamp,
      clean: "blog_digestclean" + stamp,
    };

    it("sends one email listing every blog with a problem", async function () {
      const sentEmails = [];
      const init = load(
        {
          [ids.changes]: { summary: { downloaded: 2, removed: 1 } },
          [ids.repaired]: { fixReport: { "tag-ghosts": ["a", "b"] } },
          [ids.walkError]: { walkError: new Error("walk exploded") },
          [ids.fixError]: { fixError: new Error("fix exploded") },
          [ids.syncError]: { syncError: new Error("sync exploded") },
          [ids.stuck]: { busy: true, heldSince: Date.now() - 3 * HOUR },
          [ids.briefly]: { busy: true, heldSince: Date.now() - 1000 },
          [ids.clean]: { summary: { downloaded: 1, modifiedDuringWalk: 1 } },
        },
        sentEmails
      );

      spyOn(console, "error");
      await init.validateAllBlogs();

      expect(sentEmails.length).toEqual(1);

      const byID = {};
      sentEmails[0].blogs.forEach((blog) => (byID[blog.id] = blog));

      expect(Object.keys(byID).sort()).toEqual(
        [
          ids.changes,
          ids.repaired,
          ids.walkError,
          ids.fixError,
          ids.syncError,
          ids.stuck,
        ].sort()
      );
      expect(byID[ids.changes].changeCount).toEqual(3);
      expect(byID[ids.repaired].checks[0].name).toEqual("tag-ghosts");
      expect(byID[ids.walkError].errors[0].phase).toEqual("walk");
      expect(byID[ids.fixError].errors[0].phase).toEqual("fix");
      expect(byID[ids.syncError].errors[0].phase).toEqual("catch-up sync");
      expect(byID[ids.stuck].hasStuckLock).toEqual(true);
      expect(byID[ids.stuck].lockHeldFor).toEqual("3h 0m");
    });

    it("sends nothing when no blog has a problem", async function () {
      const sentEmails = [];
      const init = load(
        {
          [ids.clean]: { summary: {} },
          [ids.briefly]: { busy: true, heldSince: Date.now() - 1000 },
        },
        sentEmails
      );

      await init.validateAllBlogs();

      expect(sentEmails.length).toEqual(0);
    });

    describe("what the user is free to do", function () {
      const health = require("clients/health");
      const userSide = [
        health.CODES.REAUTH_REQUIRED,
        health.CODES.SOURCE_MISSING,
        health.CODES.QUOTA_EXCEEDED,
      ];

      it("skips a blog with a user-side issue without walking or fixing it", async function () {
        const sentEmails = [];
        const behaviors = {};
        userSide.forEach((code) => {
          behaviors["blog_userside" + code + stamp] = {
            health: health.error([{ code }]),
            walkError: new Error("would be reported if walked"),
            fixError: new Error("would be reported if fixed"),
            heldSince: Date.now() - 3 * HOUR,
          };
        });
        const init = load(behaviors, sentEmails);

        await init.validateAllBlogs();

        expect(walked).toEqual([]);
        expect(sentEmails.length).toEqual(0);
      });

      it("drops a blog whose folder disappears during the walk", async function () {
        const sentEmails = [];
        const init = load(
          {
            [ids.walkError]: {
              walkError: new Error("folder not found"),
              // ok when the sweep starts, SOURCE_MISSING by the time it sends
              health: (reads) =>
                reads === 1
                  ? health.ok()
                  : health.error([{ code: health.CODES.SOURCE_MISSING }]),
            },
            [ids.changes]: { summary: { downloaded: 1 } },
          },
          sentEmails
        );

        spyOn(console, "error");
        await init.validateAllBlogs();

        expect(walked.length).toEqual(2);
        expect(sentEmails.length).toEqual(1);
        expect(sentEmails[0].blogs.map((blog) => blog.id)).toEqual([ids.changes]);
      });

      it("still reports a blog when its health can't be read", async function () {
        const sentEmails = [];
        const init = load(
          {
            [ids.walkError]: {
              walkError: new Error("walk exploded"),
              health: new Error("redis hiccup"),
            },
          },
          sentEmails
        );

        spyOn(console, "error");
        await init.validateAllBlogs();

        expect(walked).toEqual([ids.walkError]);
        expect(sentEmails.length).toEqual(1);
        expect(sentEmails[0].blogs[0].errors[0].phase).toEqual("walk");
      });
    });

    it("finds a stuck lock on a blog that has no recent sync", async function () {
      const sentEmails = [];
      const init = load(
        {
          [ids.stuck]: {
            heldSince: Date.now() - 5 * HOUR,
            lastSync: Date.now() - 5 * HOUR,
          },
          [ids.briefly]: { lastSync: Date.now() - 5 * HOUR },
        },
        sentEmails
      );

      await init.validateAllBlogs();

      expect(walked).toEqual([]);
      expect(sentEmails.length).toEqual(1);
      expect(sentEmails[0].blogs.map((blog) => blog.id)).toEqual([ids.stuck]);
      expect(sentEmails[0].blogs[0].hasStuckLock).toEqual(true);
    });

    it("reports a partly failed walk as a walk error, with its changes, and skips Fix()", async function () {
      const sentEmails = [];
      const init = load(
        {
          [ids.changes]: {
            summary: { downloaded: 2, failed: 1, firstError: "/a.jpg: boom" },
            fixError: new Error("must not run"),
            syncError: new Error("must not run"),
          },
        },
        sentEmails
      );

      await init.validateAllBlogs();

      const [record] = sentEmails[0].blogs;
      expect(record.changeCount).toEqual(2);
      expect(record.errors.length).toEqual(1);
      expect(record.errors[0].phase).toEqual("walk");
      expect(record.errors[0].message).toContain("/a.jpg: boom");
    });

    it("emails an ongoing error once, and again after it clears and returns", async function () {
      const behaviors = {
        [ids.walkError]: { walkError: new Error("walk exploded") },
        [ids.stuck]: { heldSince: Date.now() - 3 * HOUR },
        [ids.repaired]: { fixReport: { "tag-ghosts": ["a"] } },
      };
      const sentEmails = [];
      const init = load(behaviors, sentEmails);

      spyOn(console, "error");
      await init.validateAllBlogs();
      expect(sentEmails[0].blogs.map((blog) => blog.id).sort()).toEqual(
        [ids.walkError, ids.stuck, ids.repaired].sort()
      );

      // Same sweep again: the error and the stuck lock continue, but Fix()
      // repairs are events and are reported every time.
      await init.validateAllBlogs();
      expect(sentEmails.length).toEqual(2);
      expect(sentEmails[1].blogs.map((blog) => blog.id)).toEqual([ids.repaired]);

      // Clear them, then bring them back.
      delete behaviors[ids.walkError].walkError;
      delete behaviors[ids.stuck].heldSince;
      delete behaviors[ids.repaired].fixReport;
      await init.validateAllBlogs();
      expect(sentEmails.length).toEqual(2);

      behaviors[ids.walkError].walkError = new Error("walk exploded");
      behaviors[ids.stuck].heldSince = Date.now() - 3 * HOUR;
      await init.validateAllBlogs();
      expect(sentEmails.length).toEqual(3);
      expect(sentEmails[2].blogs.map((blog) => blog.id).sort()).toEqual(
        [ids.walkError, ids.stuck].sort()
      );
    });
  });
});
