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

  state.run = async (options) => {
    const summary = {
      downloaded: 0,
      removed: 0,
      createdDirs: 0,
      modifiedDuringWalk: 0,
    };

    const succeeded = await module.exports(
      "blog",
      () => {},
      async (path) => state.updates.push(path),
      { ...options, summary }
    );

    return { succeeded, summary };
  };

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

  it("excludes a download modified at/after the cutoff (minus grace) from modifiedDuringWalk", async function () {
    const since = Date.parse("2026-09-19T16:00:00Z");
    const h = harness([
      file({ modifiedTime: "2026-09-19T15:59:57Z" }), // inside the 30s grace
    ]);

    const { succeeded, summary } = await h.run({ since });

    expect(succeeded).toBe(true);
    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(1);
  });

  it("counts a download modified well before the cutoff as a missed change", async function () {
    const since = Date.parse("2026-09-19T16:00:00Z");
    const h = harness([
      file({ modifiedTime: "2026-09-19T15:00:00Z" }),
    ]);

    const { summary } = await h.run({ since });

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(0);
  });

  it("does not count a download whose bytes already matched", async function () {
    const h = harness([file({ modifiedTime: "2026-09-19T15:00:00Z" })]);
    h.downloadResult = {
      updated: false,
      verifiedContent: { checksum: "md5", fingerprint: "f" },
    };

    const { summary } = await h.run({ since: Date.parse("2026-09-19T16:00:00Z") });

    expect(h.updates.length).toBe(1);
    expect(summary.downloaded).toBe(0);
  });

  it("does not exclude anything when no cutoff is passed", async function () {
    const h = harness([file({ modifiedTime: new Date().toISOString() })]);

    const { summary } = await h.run({});

    expect(summary.downloaded).toBe(1);
    expect(summary.modifiedDuringWalk).toBe(0);
  });
});
