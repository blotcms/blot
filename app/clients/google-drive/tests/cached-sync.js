const fs = require("fs");
const vm = require("vm");

// Runs fn's source (a module of the client) in a sandbox, with stubs for the
// modules it requires
function load(file, stubs) {
  const module = {
    exports: {},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), "utf8"), {
    module,
    exports: module.exports,
    console: {
      log() {},
      error() {},
    },
    require: (name) => (name in stubs ? stubs[name] : require(name)),
  });
  return module.exports;
}

function harness(count = 1) {
  // Records from before util/hashes.js, by file ID (getVerifiedContents)
  const records = new Map();
  const metadata = new Map();
  // Drive's md5Checksum by SHA-1, as util/hashes.js has saved them
  const pairs = new Map();
  const files = Array.from(
    {
      length: count,
    },
    (_, i) => ({
      id: String(i),
      name: String(i).padStart(4, "0") + ".txt",
      size: 4,
      mimeType: "text/plain",
      modifiedTime: "2026-01-01T00:00:00Z",
      md5Checksum: "md5",
    })
  );
  // Blot's copy of each file, as storage/folder lists it, with the SHA-1
  // the folder's index has for it
  const local = files.map((file) => ({
    id: file.id,
    name: file.name,
    isDirectory: false,
    size: 4,
    modified: 1000,
    modifiedTime: new Date(1000).toISOString(),
    sha1: "sha1-" + file.id,
  }));
  const state = {
    files,
    local,
    records,
    metadata,
    pairs,
    saves: [],
    downloads: [],
    batches: [],
    updates: [],
    hashed: [],
    failDownload: false,
    failUpdate: false,
    failStore: false,
  };
  const byPath = (path) => local.find((file) => "/" + file.name === path);
  const localState = load("../util/localState", {
    "storage/folder": {
      stat: async (blogID, path, options) => {
        const file = byPath(path);
        if (!file)
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        if (options && options.sha1) state.hashed.push(path);
        return {
          isDirectory: false,
          size: file.size,
          modified: file.modified,
          sha1: options && options.sha1 ? file.sha1 : undefined,
        };
      },
    },
  });
  const stubs = {
    "storage/folder": {},
    "../database": {
      blog: {
        get: async () => ({
          folderId: "folder",
          folderName: "folder",
          serviceAccountId: "service",
        }),
      },
      folder: () => ({
        get: async () => null,
        getByPath: async () => null,
        getApplied: async (id) => metadata.get(id) || null,
        setApplied: async (id, value) => {
          metadata.set(id, value);
        },
        set: async () => {},
        remove: async () => {},
        getVerifiedContents: async (ids) => {
          state.batches.push(ids);
          return ids.map((id) => records.get(id));
        },
      }),
    },
    // An in-memory util/hashes.js: a sync's pairs reach the store when it
    // saves, unless the store is failing
    "../util/hashes": {
      load: async () => {
        const known = new Map(pairs);
        return {
          get: (sha1) => known.get(sha1),
          set: (sha1, md5) => known.set(sha1, md5),
          async save(options) {
            state.saves.push(options);
            if (state.failStore) return;
            pairs.clear();
            for (const [sha1, md5] of known) pairs.set(sha1, md5);
          },
        };
      },
    },
    "../util/download": async (blog, drive, path, remote) => {
      state.downloads.push(remote.id);
      if (state.failDownload) throw Error("unavailable");
      if (!remote.md5Checksum)
        return {
          updated: true,
        };
      const file = local.find((file) => file.id === remote.id);
      return {
        updated: false,
        verifiedContent: {
          checksum: remote.md5Checksum,
          sha1: file.sha1,
        },
      };
    },
    "../util/localState": localState,
    "../serviceAccount/createDriveClient": async () => ({
      files: {
        get: async () => ({
          data: {
            name: "folder",
          },
        }),
      },
    }),
    "../util/checkWeCanContinue": () => async () => {},
    "clients/util/shouldIgnoreFile": () => false,
    "clients/util/resyncProgress": {
      countLocalFiles: async () => count,
      createProgress: () => ({
        publish() {},
        publishThrottled() {},
        discover() {},
        finish(message) {
          state.finished = message;
        },
      }),
    },
    "./util/driveReaddir": async () => files,
    "./util/localReaddir": async () => local,
    "./util/transformDriveItems": require("../sync/util/transformDriveItems"),
    "./util/truncateToSecond": require("../sync/util/truncateToSecond"),
    "./util/limiter": require("../sync/util/limiter"),
    "./util/comparePaths": require("../sync/util/comparePaths"),
  };
  const sync = load("../sync/sync", stubs);
  state.run = () =>
    sync(
      "blog",
      () => {},
      async (path) => {
        state.updates.push(path);
        if (state.failUpdate) throw Error("build failed");
      }
    );
  // Every file paired with its md5Checksum, as when Blot last verified it
  state.warm = () =>
    files.forEach((file) => pairs.set("sha1-" + file.id, file.md5Checksum));
  // The same, as verified records written before util/hashes.js
  state.warmRecords = () =>
    files.forEach((file) =>
      records.set(file.id, {
        path: "/" + file.name,
        checksum: file.md5Checksum,
        sha1: "sha1-" + file.id,
        size: 4,
        modified: 1000,
      })
    );
  return state;
}
describe("Drive verified content cache", function () {
  it("skips 1000 unchanged files without content reads and batches the directory lookup", async function () {
    const h = harness(1000);
    h.warm();
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.hashed).toEqual([]);
    expect(h.finished).toBe("Finished processing folder");
    // The records from before util/hashes.js, in one request
    expect(h.batches.length).toBe(1);
    expect(h.batches[0].length).toBe(1000);
  });
  it("verifies same-size remote edits and local replacements", async function () {
    const h = harness(3);
    h.warm();
    h.files[0].md5Checksum = "new";
    h.local[1].sha1 = "replaced";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0", "1"]);
    expect(h.pairs.get("sha1-0")).toBe("new");
    expect(h.pairs.get("replaced")).toBe("md5");
  });
  it("downloads nothing when only the modified time or size moved, reading nothing", async function () {
    const h = harness(2);
    h.warm();
    h.local[0].size = 5;
    h.local[1].modified = 2000;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.hashed).toEqual([]);
  });
  it("checks a file whose SHA-1 changed, without hashing it", async function () {
    const h = harness(1);
    h.warm();
    h.local[0].sha1 = "edited";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
    expect(h.hashed).toEqual([]);
  });
  it("matches a file wherever it is: a pair is by SHA-1, not path or ID", async function () {
    const h = harness(2);
    h.warm();
    // Moved and renamed in Drive and in the folder: a new ID, a new name
    h.files[1].id = "moved";
    h.files[1].name = h.local[1].name = "renamed.txt";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
  });
  it("leaves a file the index has no SHA-1 for to download()", async function () {
    const h = harness(1);
    h.warm();
    delete h.local[0].sha1;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
    expect(h.hashed).toEqual([]);
  });
  it("takes over a verified record from before util/hashes.js", async function () {
    const h = harness(2);
    h.warmRecords();
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.pairs.get("sha1-0")).toBe("md5");
    expect(h.pairs.get("sha1-1")).toBe("md5");
    // The pairs are enough from then on
    h.records.clear();
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
  });
  it("doesn't take over an old record for other bytes or another md5Checksum", async function () {
    const h = harness(2);
    h.warmRecords();
    h.local[0].sha1 = "edited";
    h.files[1].md5Checksum = "new";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0", "1"]);
  });
  it("saves a whole walk as complete, dropping pairs it didn't use", async function () {
    const h = harness(1);
    h.warm();
    expect(await h.run()).toBeTruthy();
    expect(h.saves).toEqual([{ complete: true }]);
  });
  it("saves a walk with a failed download as incomplete", async function () {
    const h = harness(1);
    h.failDownload = true;
    expect(await h.run()).toBeTruthy();
    expect(h.saves).toEqual([{ complete: false }]);
  });
  it("verifies every unverified equal-size file in one sync", async function () {
    const h = harness(70);
    expect(await h.run()).toBeTruthy();
    expect(h.downloads.length).toBe(70);
    expect(h.finished).toBe("Finished processing folder");
    h.downloads = [];
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
  });
  it("rebuilds again after failed update or cache persistence, then warms", async function () {
    const h = harness();
    h.failUpdate = true;
    expect(await h.run()).toBeTruthy();
    expect(h.pairs.size).toBe(0);
    h.failUpdate = false;
    h.failStore = true;
    expect(await h.run()).toBeTruthy();
    expect(h.pairs.size).toBe(0);
    h.failStore = false;
    expect(await h.run()).toBeTruthy();
    expect(h.pairs.size).toBe(1);
    expect(h.updates.length).toBe(3);
    expect(await h.run()).toBeTruthy();
    expect(h.updates.length).toBe(3);
  });
  it("uses metadata for unchanged files with no remote checksum", async function () {
    const h = harness();
    delete h.files[0].md5Checksum;
    h.local[0].modifiedTime = h.files[0].modifiedTime;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    h.files[0].modifiedTime = "2026-01-02T00:00:00Z";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
  });
  it("treats a Google-app file as identical when the stored modifiedTime matches, even if the local mtime differs", async function () {
    const h = harness();
    h.files[0].mimeType = "application/vnd.google-apps.spreadsheet";
    delete h.files[0].md5Checksum;
    h.metadata.set("0", {
      modifiedTime: h.files[0].modifiedTime,
      sha1: "sha1-0",
    });
    h.local[0].modifiedTime = "2020-01-01T00:00:00Z";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
  });
  it("downloads a Google-app file when the stored modifiedTime is older than the remote one", async function () {
    const h = harness();
    h.files[0].mimeType = "application/vnd.google-apps.spreadsheet";
    delete h.files[0].md5Checksum;
    h.metadata.set("0", {
      modifiedTime: "2026-01-01T00:00:00Z",
      sha1: "sha1-0",
    });
    h.files[0].modifiedTime = "2026-01-02T00:00:00Z";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
    expect(h.metadata.get("0")).toEqual({
      modifiedTime: "2026-01-02T00:00:00Z",
      sha1: "sha1-0",
    });
  });
  it("downloads a Google-app file changed locally since Blot wrote it, even if Drive's time is unchanged", async function () {
    const h = harness();
    h.files[0].mimeType = "application/vnd.google-apps.spreadsheet";
    delete h.files[0].md5Checksum;
    h.metadata.set("0", {
      modifiedTime: h.files[0].modifiedTime,
      sha1: "written-by-blot",
    });
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
  });
});
