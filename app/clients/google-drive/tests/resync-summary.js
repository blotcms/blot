const fs = require("fs");
const vm = require("vm");

// Trimmed-down version of the cached-sync.js harness: runs the real sync.js
// in a sandbox with its collaborators stubbed out, so the modifiedDuringWalk
// exclusion (clients/util/modifiedSince) can be exercised against a remote
// file's modifiedTime without touching the filesystem or Google's API.
function harness(files) {
  const local = [];
  const state = {
    files,
    local,
    downloads: [],
    updates: [],
    downloadResult: { updated: true },
  };

  const stubs = {
    "fs-extra": {
      remove: async () => {},
      ensureDir: async () => {},
    },
    "helper/localPath": (_, path) => path,
    "../database": {
      blog: {
        get: async () => ({
          folderId: "folder",
          folderName: "folder",
          serviceAccountId: "service",
        }),
      },
      folder: () => ({
        getByPath: async () => null,
        set: async () => {},
        remove: async () => {},
        getMigrationCursor: async () => "",
        setMigrationCursor: async () => {},
        getVerifiedContents: async (ids) => ids.map(() => undefined),
        setVerifiedContent: async () => {},
      }),
    },
    "../util/download": async (blog, drive, path, remote) => {
      state.downloads.push(remote.id);
      return state.downloadResult;
    },
    "../serviceAccount/createDriveClient": async () => ({
      files: {
        get: async () => ({ data: { name: "folder" } }),
      },
    }),
    "../util/checkWeCanContinue": () => async () => {},
    "clients/util/shouldIgnoreFile": () => false,
    "clients/util/modifiedSince": require("../../util/modifiedSince"),
    "clients/util/resyncProgress": {
      countLocalFiles: async () => 0,
      createProgress: () => ({
        publish() {},
        publishThrottled() {},
        discover() {},
        finish() {},
      }),
    },
    "./util/driveReaddir": async () => files,
    "./util/localReaddir": async () => local,
    "./util/transformDriveItems": require("../sync/util/transformDriveItems"),
    "./util/truncateToSecond": require("../sync/util/truncateToSecond"),
    "./util/migrationBudget": require("../sync/util/migrationBudget"),
    "./util/comparePaths": require("../sync/util/comparePaths"),
  };

  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../sync/sync"), "utf8"),
    {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      require: (name) => (name in stubs ? stubs[name] : require(name)),
    }
  );

  state.run = () =>
    module.exports("blog", () => {}, async (path) => state.updates.push(path));

  return state;
}

describe("google-drive sync() resync summary", function () {
  function file(overrides) {
    return {
      id: "1",
      name: "post.txt",
      size: 4,
      mimeType: "text/plain",
      modifiedTime: "2026-01-01T00:00:00Z",
      md5Checksum: "md5",
      ...overrides,
    };
  }

  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  it("excludes a download modified around or after the walk started from modifiedDuringWalk", async function () {
    // inside the 30s grace period before the walk started
    const h = harness([file({ modifiedTime: ago(3000) })]);

    const summary = await h.run();

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(1);
  });

  it("counts a download modified well before the walk started as a missed change", async function () {
    const h = harness([file({ modifiedTime: ago(60 * 60 * 1000) })]);

    const summary = await h.run();

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(0);
  });

  it("does not count a download whose bytes already matched", async function () {
    const h = harness([file({ modifiedTime: ago(60 * 60 * 1000) })]);
    h.downloadResult = {
      updated: false,
      verifiedContent: { checksum: "md5", fingerprint: "f" },
    };

    const summary = await h.run();

    expect(h.updates.length).toBe(1);
    expect(summary.downloaded).toBe(0);
  });
});
