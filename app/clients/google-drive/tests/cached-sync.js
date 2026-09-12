const fs = require("fs");
const vm = require("vm");

function harness(count = 1) {
  const records = new Map();
  const files = Array.from({
    length: count
  }, (_, i) => ({
    id: String(i),
    name: String(i).padStart(4, "0") + ".txt",
    size: 4,
    mimeType: "text/plain",
    modifiedTime: "2026-01-01T00:00:00Z",
    md5Checksum: "md5"
  }));
  const local = files.map(file => ({
    ...file,
    fingerprint: "local-" + file.id
  }));
  let cursor = "";
  const state = {
    files,
    local,
    records,
    downloads: [],
    batches: [],
    updates: [],
    failDownload: false,
    failUpdate: false,
    failStore: false
  };
  const stubs = {
    "fs-extra": {},
    "helper/localPath": (_, path) => path,
    "../database": {
      blog: {
        get: async () => ({
          folderId: "folder",
          folderName: "folder",
          serviceAccountId: "service"
        })
      },
      folder: () => ({
        getByPath: async () => null,
        set: async () => {},
        remove: async () => {},
        getMigrationCursor: async () => cursor,
        setMigrationCursor: async value => {
          cursor = value;
        },
        getVerifiedContents: async ids => {
          state.batches.push(ids);
          return ids.map(id => records.get(id));
        },
        setVerifiedContent: async (id, value) => {
          if (state.failStore) throw Error("cache unavailable");
          records.set(id, value);
        },
      })
    },
    "../util/download": async (blog, drive, path, remote) => {
      state.downloads.push(remote.id);
      if (state.failDownload) throw Error("unavailable");
      if (!remote.md5Checksum) return {
        updated: true
      };
      return {
        updated: false,
        verifiedContent: {
          checksum: remote.md5Checksum,
          fingerprint: local.find(file => file.id === remote.id).fingerprint
        }
      };
    },
    "../serviceAccount/createDriveClient": async () => ({
      files: {
        get: async () => ({
          data: {
            name: "folder"
          }
        })
      }
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
        }
      })
    },
    "./util/driveReaddir": async () => files,
    "./util/localReaddir": async () => local,
    "./util/transformDriveItems": require("../sync/util/transformDriveItems"),
    "./util/truncateToSecond": require("../sync/util/truncateToSecond"),
    "./util/migrationBudget": require("../sync/util/migrationBudget"),
    "./util/comparePaths": require("../sync/util/comparePaths"),
  };
  const module = {
    exports: {}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../sync/sync"), "utf8"), {
    module,
    exports: module.exports,
    console: {
      log() {},
      error() {}
    },
    require: name => name in stubs ? stubs[name] : require(name),
  });
  state.run = () => module.exports("blog", () => {}, async path => {
    state.updates.push(path);
    if (state.failUpdate) throw Error("build failed");
  });
  state.warm = () => files.forEach(file => records.set(file.id, {
    path: "/" + file.name,
    checksum: file.md5Checksum,
    fingerprint: "local-" + file.id
  }));
  return state;
}
describe("Drive verified content cache", function() {
  it("skips 1000 unchanged files without content reads and batches the directory lookup", async function() {
    const h = harness(1000);
    h.warm();
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.finished).toBe("Finished processing folder");
    expect(h.batches.length).toBe(1);
    expect(h.batches[0].length).toBe(1000);
  });
  it("verifies same-size remote edits and local replacements", async function() {
    const h = harness(3);
    h.warm();
    h.files[0].md5Checksum = "new";
    h.local[1].fingerprint = "replaced";
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["0", "1"]);
    expect(h.records.get("0").checksum).toBe("new");
  });
  it("bounds legacy migration and advances beyond a repeatedly failing prefix", async function() {
    const h = harness(70);
    h.failDownload = true;
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(Array.from({
      length: 32
    }, (_, i) => String(i)));
    expect(h.finished).toContain("deferred");
    h.downloads = [];
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(Array.from({
      length: 32
    }, (_, i) => String(i + 32)));
    h.downloads = [];
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["64", "65", "66", "67", "68", "69"]);
    h.failDownload = false;
    h.downloads = [];
    expect(await h.run()).toBe(true);
    expect(h.downloads[0]).toBe("0");
  });
  it("stops at the byte limit and eventually verifies an oversized file alone", async function() {
    const h = harness(3);
    [40, 80, 1].forEach((size, i) => {
      h.files[i].size = size * 1024 * 1024;
      h.local[i].size = h.files[i].size;
    });
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["0"]);
    h.downloads = [];
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["1"]);
    h.downloads = [];
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["2"]);
  });
  it("rebuilds again after failed update or cache persistence, then warms", async function() {
    const h = harness();
    h.failUpdate = true;
    expect(await h.run()).toBe(true);
    expect(h.records.size).toBe(0);
    h.failUpdate = false;
    h.failStore = true;
    expect(await h.run()).toBe(true);
    expect(h.records.size).toBe(0);
    h.failStore = false;
    expect(await h.run()).toBe(true);
    expect(h.records.size).toBe(1);
    expect(h.updates.length).toBe(3);
    expect(await h.run()).toBe(true);
    expect(h.updates.length).toBe(3);
  });
  it("uses metadata for unchanged files with no remote checksum", async function() {
    const h = harness();
    delete h.files[0].md5Checksum;
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual([]);
    h.files[0].modifiedTime = "2026-01-02T00:00:00Z";
    expect(await h.run()).toBe(true);
    expect(h.downloads).toEqual(["0"]);
  });
});
