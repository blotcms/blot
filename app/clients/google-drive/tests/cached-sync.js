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
  const records = new Map();
  const metadata = new Map();
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
  // Blot's copy of each file, as storage/folder lists it, plus its SHA-1
  // and the fingerprint the disk would give it (util/localFingerprint.js)
  const local = files.map((file) => ({
    id: file.id,
    name: file.name,
    isDirectory: false,
    size: 4,
    modified: 1000,
    modifiedTime: new Date(1000).toISOString(),
    sha1: "sha1-" + file.id,
    fingerprint: "4:1000000000",
  }));
  const state = {
    files,
    local,
    records,
    metadata,
    downloads: [],
    batches: [],
    updates: [],
    hashed: [],
    fingerprinted: [],
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
    "./contentFingerprint": require("../util/contentFingerprint"),
    "./localFingerprint": async (blogID, path) => {
      state.fingerprinted.push(path);
      return byPath(path)?.fingerprint || null;
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
        setVerifiedContent: async (id, value) => {
          if (state.failStore) throw Error("cache unavailable");
          records.set(id, value);
        },
      }),
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
          size: file.size,
          modified: file.modified,
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
  // A verified record for every file, written when Blot last downloaded it
  state.warm = () =>
    files.forEach((file) =>
      records.set(file.id, {
        path: "/" + file.name,
        checksum: file.md5Checksum,
        sha1: "sha1-" + file.id,
        size: 4,
        modified: 1000,
      })
    );
  // The same, in the form written before records held the file's state
  state.warmLegacy = (fingerprint = "64768:99:4:1000000000:2000") =>
    files.forEach((file) =>
      records.set(file.id, {
        path: "/" + file.name,
        checksum: file.md5Checksum,
        fingerprint,
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
    expect(h.fingerprinted).toEqual([]);
    expect(h.finished).toBe("Finished processing folder");
    expect(h.batches.length).toBe(1);
    expect(h.batches[0].length).toBe(1000);
  });
  it("verifies same-size remote edits and local replacements", async function () {
    const h = harness(3);
    h.warm();
    h.files[0].md5Checksum = "new";
    h.local[1].modified = 2000;
    h.local[1].sha1 = "replaced";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0", "1"]);
    expect(h.records.get("0").checksum).toBe("new");
    expect(h.records.get("1")).toEqual({
      path: "/0001.txt",
      checksum: "md5",
      sha1: "replaced",
      size: 4,
      modified: 2000,
    });
  });
  it("downloads nothing when only the modified time moved, and updates the record", async function () {
    const h = harness(2);
    h.warm();
    h.local[1].modified = 2000;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.hashed).toEqual(["/0001.txt"]);
    expect(h.records.get("1").modified).toBe(2000);
    h.hashed = [];
    expect(await h.run()).toBeTruthy();
    expect(h.hashed).toEqual([]);
  });
  it("detects a change in size without hashing", async function () {
    const h = harness(1);
    h.warm();
    h.local[0].size = 5;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
    expect(h.hashed).toEqual([]);
  });
  it("rounds a modified time with a fraction of a millisecond, as the index stores it", async function () {
    const h = harness(1);
    h.warm();
    h.local[0].modified = 1000.4;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.hashed).toEqual([]);
  });
  it("detects a change against a record without a SHA-1", async function () {
    const h = harness(2);
    h.warm();
    h.files.forEach((file) => delete h.records.get(file.id).sha1);
    h.local[1].modified = 2000;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["1"]);
    expect(h.hashed).toEqual([]);
  });
  it("keeps old fingerprint records valid for unchanged files, and replaces them", async function () {
    const h = harness(2);
    h.warmLegacy();
    h.files[1].mimeType = "application/vnd.google-apps.document";
    delete h.files[1].md5Checksum;
    // the walk names a Google Doc <name>.gdoc, as it is on disk
    h.local[1].name += ".gdoc";
    h.metadata.set("1", {
      modifiedTime: h.files[1].modifiedTime,
      fingerprint: "64768:99:4:1000000000:2000",
    });
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.hashed).toEqual([]);
    expect(h.records.get("0")).toEqual({
      path: "/0000.txt",
      checksum: "md5",
      size: 4,
      modified: 1000,
      sha1: null,
    });
    expect(h.metadata.get("1")).toEqual({
      modifiedTime: h.files[1].modifiedTime,
      size: 4,
      modified: 1000,
      sha1: null,
    });
    // the next sync matches the new records without asking the disk (the
    // walk renamed the Doc's listing in place, so list it afresh)
    h.files[1].name = "0001.txt";
    h.fingerprinted = [];
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
    expect(h.fingerprinted).toEqual([]);
  });
  it("keeps two-field fingerprint records valid too", async function () {
    const h = harness(1);
    h.warmLegacy("4:1000000000");
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual([]);
  });
  it("rejects old fingerprint records when the size or mtime differs", async function () {
    const h = harness(3);
    h.warmLegacy();
    h.local[0].fingerprint = "4:1000000001";
    h.local[1].size = 5;
    h.local[1].fingerprint = "5:1000000000";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0", "1"]);
    // the size alone rules out the second, without asking the disk
    expect(h.fingerprinted).toEqual(["/0000.txt", "/0002.txt"]);
    expect(h.records.get("0").sha1).toBe("sha1-0");
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
    expect(h.records.size).toBe(0);
    h.failUpdate = false;
    h.failStore = true;
    expect(await h.run()).toBeTruthy();
    expect(h.records.size).toBe(0);
    h.failStore = false;
    expect(await h.run()).toBeTruthy();
    expect(h.records.size).toBe(1);
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
      size: 4,
      modified: 1000,
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
      size: 4,
      modified: 1000,
      sha1: "sha1-0",
    });
    h.files[0].modifiedTime = "2026-01-02T00:00:00Z";
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
    expect(h.metadata.get("0")).toEqual({
      modifiedTime: "2026-01-02T00:00:00Z",
      size: 4,
      modified: 1000,
      sha1: "sha1-0",
    });
  });
  it("downloads a Google-app file changed locally since Blot wrote it, even if Drive's time is unchanged", async function () {
    const h = harness();
    h.files[0].mimeType = "application/vnd.google-apps.spreadsheet";
    delete h.files[0].md5Checksum;
    h.metadata.set("0", {
      modifiedTime: h.files[0].modifiedTime,
      size: 4,
      modified: 1000,
      sha1: "written-by-blot",
    });
    h.local[0].modified = 2000;
    expect(await h.run()).toBeTruthy();
    expect(h.downloads).toEqual(["0"]);
  });
});
