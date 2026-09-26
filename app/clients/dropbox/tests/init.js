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

  // establishSyncLock's retry loop can take several seconds, so the account
  // state a caller saw before queuing for the lock can be stale by the time
  // it's actually held - e.g. a "Retry transfer" reconnect could start (or a
  // transfer could fail) in that window. resetToBlotWithLock must re-read the
  // account after acquiring the lock and refuse to run resetToBlot if it's
  // now (or still) incomplete, rather than trusting the caller's earlier check.
  describe("resetToBlotWithLock rechecks transferIncomplete once the lock is held", function () {
    const databasePath = require.resolve("../database");
    const resetToBlotPath = require.resolve("../sync/reset-to-blot");
    const lockPath = require.resolve("sync/establishSyncLock");
    const initPath = require.resolve("../init");

    const blogID = "blog_lockrecheck" + Date.now();
    const originals = {};

    beforeEach(function () {
      [databasePath, resetToBlotPath, lockPath, initPath].forEach(
        (path) => (originals[path] = require.cache[path])
      );
    });

    afterEach(function () {
      [databasePath, resetToBlotPath, lockPath].forEach((path) => {
        if (originals[path]) require.cache[path] = originals[path];
        else delete require.cache[path];
      });
      delete require.cache[initPath];
      if (originals[initPath]) require.cache[initPath] = originals[initPath];
    });

    function load(accountUnderLock, resetToBlotBehavior) {
      require.cache[databasePath] = {
        exports: {
          get: function (_blogID, callback) {
            callback(null, accountUnderLock);
          },
          set: function (_blogID, _values, callback) {
            callback(null);
          },
        },
      };
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

    it("returns the TRANSFER_INCOMPLETE sentinel and never calls resetToBlot when the account is incomplete under the lock", async function () {
      let resetToBlotCalled = false;
      const init = load(
        { error_code: 0, transfer_pending: true },
        function () {
          resetToBlotCalled = true;
          return Promise.resolve({ downloaded: 1 });
        }
      );

      const result = await init.resetToBlotWithLock(blogID, () => {});

      expect(result).toEqual(init.TRANSFER_INCOMPLETE);
      expect(resetToBlotCalled).toEqual(false);
    });

    it("runs resetToBlot and returns its summary when the account is still complete under the lock", async function () {
      const init = load({ error_code: 0, transfer_pending: false }, function () {
        return Promise.resolve({ downloaded: 1 });
      });

      const result = await init.resetToBlotWithLock(blogID, () => {});

      expect(result).toEqual({ downloaded: 1 });
    });
  });

  // End-to-end version of the same race, through validateAllBlogs: its own
  // cheap pre-check (before queuing for the lock) sees a complete transfer,
  // but the account has become incomplete by the time resetToBlotWithLock
  // actually acquires the lock and re-reads it.
  describe("validateAllBlogs does not run resetToBlot when the account becomes incomplete while queued for the lock", function () {
    const blogPath = require.resolve("models/blog");
    const databasePath = require.resolve("../database");
    const resetToBlotPath = require.resolve("../sync/reset-to-blot");
    const lockPath = require.resolve("sync/establishSyncLock");
    const initPath = require.resolve("../init");

    const blogID = "blog_lockracetest" + Date.now();
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

    it("skips it", async function () {
      let resetToBlotCalled = false;
      let call = 0;

      require.cache[blogPath] = {
        exports: {
          getAllIDs: function (callback) {
            callback(null, [blogID]);
          },
          get: function (query, callback) {
            callback(null, { id: blogID, handle: "race-blog", client: "dropbox" });
          },
        },
      };
      require.cache[databasePath] = {
        exports: {
          // Call 1: validateAllBlogs' own pre-check, before queuing for the
          // lock - reports the transfer as complete.
          // Call 2: resetToBlotWithLock's re-check, once the lock is held -
          // reports it as incomplete (a retry started, or it failed, in the
          // meantime).
          get: function (_blogID, callback) {
            call += 1;
            callback(
              null,
              call === 1
                ? { error_code: 0, transfer_pending: false, last_sync: Date.now() }
                : { error_code: 0, transfer_pending: true, last_sync: Date.now() }
            );
          },
          set: function (_blogID, _values, callback) {
            callback(null);
          },
        },
      };
      require.cache[resetToBlotPath] = {
        exports: function () {
          resetToBlotCalled = true;
          return Promise.resolve({ downloaded: 1 });
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
      const init = require("../init");

      await init.validateAllBlogs();

      expect(resetToBlotCalled).toEqual(false);
    });
  });
});
