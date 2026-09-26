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
});
