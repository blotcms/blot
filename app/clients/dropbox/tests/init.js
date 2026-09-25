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
});
