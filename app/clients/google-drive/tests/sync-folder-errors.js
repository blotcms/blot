const fs = require("fs");
const vm = require("vm");
const health = require("clients/health");
const { MESSAGES } = require("../database/error");

function harness(options) {
  options = options || {};

  const stored = [];
  const published = [];
  let walked = false;
  const account = {
    folderId: "folder",
    folderName: "folder",
    serviceAccountId: "service",
  };

  const stubs = {
    "fs-extra": {},
    "helper/localPath": function (_, path) {
      return path;
    },
    "../database": {
      blog: {
        get: async function () {
          return account;
        },
        store: async function (blogID, data) {
          stored.push({ blogID: blogID, data: data });
        },
      },
      folder: function () {
        return {
          getByPath: async function () {
            return null;
          },
          set: async function () {},
          remove: async function () {},
          getMigrationCursor: async function () {
            return "";
          },
          setMigrationCursor: async function () {},
          getVerifiedContents: async function () {
            return [];
          },
          setVerifiedContent: async function () {},
        };
      },
    },
    "../database/error": require("../database/error"),
    "../util/download": async function () {
      return { updated: false };
    },
    "../serviceAccount/createDriveClient": async function () {
      return {
        files: {
          get: async function () {
            if (options.lookupError) throw options.lookupError;
            return {
              data: {
                name: "folder",
                trashed: Boolean(options.trashed),
              },
            };
          },
        },
      };
    },
    "../util/checkWeCanContinue": function () {
      return async function () {};
    },
    "clients/util/shouldIgnoreFile": function () {
      return false;
    },
    "clients/util/resyncProgress": {
      countLocalFiles: async function () {
        return 0;
      },
      createProgress: function () {
        return {
          publish: function () {},
          publishThrottled: function () {},
          discover: function () {},
          finish: function () {},
        };
      },
    },
    "./util/driveReaddir": async function () {
      walked = true;
      return [];
    },
    "./util/localReaddir": async function () {
      return [];
    },
    "./util/transformDriveItems": require("../sync/util/transformDriveItems"),
    "./util/truncateToSecond": require("../sync/util/truncateToSecond"),
    "./util/migrationBudget": require("../sync/util/migrationBudget"),
    "./util/comparePaths": require("../sync/util/comparePaths"),
  };

  const module = { exports: {} };

  vm.runInNewContext(fs.readFileSync(require.resolve("../sync/sync"), "utf8"), {
    module,
    exports: module.exports,
    console: {
      log: function () {},
      error: function () {},
    },
    require: function (name) {
      return Object.prototype.hasOwnProperty.call(stubs, name)
        ? stubs[name]
        : require(name);
    },
  });

  return {
    stored: stored,
    published: published,
    run: async function () {
      return module.exports(
        "blog",
        function () {
          published.push(Array.prototype.slice.call(arguments));
        },
        async function () {}
      );
    },
    didWalk: function () {
      return walked;
    },
  };
}

describe("google drive sync folder health", function () {
  it("stores SOURCE_MISSING and stops when the folder is trashed", async function () {
    const h = harness({ trashed: true });
    expect(await h.run()).toBe(false);
    expect(h.didWalk()).toBe(false);
    expect(h.stored.length).toBe(1);
    expect(h.stored[0].data.error).toBe(MESSAGES.TRASHED);
    expect(h.stored[0].data.errorCode).toBe(health.CODES.SOURCE_MISSING);
    expect(h.stored[0].data.folderId).toBeNull();
    expect(typeof h.stored[0].data.errorSince).toBe("number");
  });

  it("stores SOURCE_MISSING and stops when the folder is deleted", async function () {
    const h = harness({ lookupError: { code: 404, message: "not found" } });
    expect(await h.run()).toBe(false);
    expect(h.didWalk()).toBe(false);
    expect(h.stored[0].data.error).toBe(MESSAGES.DELETED);
    expect(h.stored[0].data.errorCode).toBe(health.CODES.SOURCE_MISSING);
  });

  it("stores SOURCE_MISSING when the service account loses access", async function () {
    const h = harness({
      lookupError: {
        code: 403,
        errors: [{ reason: "insufficientFilePermissions" }],
        message: "forbidden",
      },
    });
    expect(await h.run()).toBe(false);
    expect(h.didWalk()).toBe(false);
    expect(h.stored[0].data.error).toBe(MESSAGES.INACCESSIBLE);
    expect(h.stored[0].data.errorCode).toBe(health.CODES.SOURCE_MISSING);
  });

  it("does not persist a rate-limit failure as health", async function () {
    const h = harness({
      lookupError: { code: 429, message: "rate limit" },
    });
    expect(await h.run()).toBe(false);
    expect(h.didWalk()).toBe(false);
    expect(h.stored).toEqual([]);
    expect(h.published[0][0]).toBe("Sync failed");
  });
});
