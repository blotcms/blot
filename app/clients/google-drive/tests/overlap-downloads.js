const fs = require("fs");
const vm = require("vm");

// Runs the real sync.js with its collaborators stubbed out, and lets a spec
// hold each download and each update open until it releases it.
function harness(count, { canContinue = async () => {} } = {}) {
  const files = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    name: "file" + i + ".txt",
    size: 4,
    mimeType: "text/plain",
    modifiedTime: "2026-01-01T00:00:00Z",
    md5Checksum: "md5-" + i,
  }));
  const state = {
    events: [],
    downloadGates: new Map(),
    updateGates: new Map(),
    runningUpdates: 0,
    maxRunningUpdates: 0,
    applied: [],
  };
  // A promise which resolves when the spec opens the gate
  const gate = (gates, key) => {
    let open;
    const promise = new Promise((resolve) => (open = resolve));
    gates.set(key, open);
    return promise;
  };

  const stubs = {
    "storage/folder": { remove: async () => {}, mkdir: async () => {} },
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
        getVerifiedContents: async (ids) => ids.map(() => undefined),
        setVerifiedContent: async () => {},
        getApplied: async () => null,
        setApplied: async (id) => {
          state.applied.push(id);
        },
      }),
    },
    "../util/localState": {
      stamp: require("../util/localState").stamp,
      unchanged: async () => null,
      stateOf: async () => ({ size: 1, modified: 1000, sha1: "sha1" }),
    },
    "../util/download": async (blog, drive, path, remote) => {
      state.events.push("download start " + remote.id);
      await gate(state.downloadGates, remote.id);
      state.events.push("download end " + remote.id);
      return { updated: true };
    },
    "../serviceAccount/createDriveClient": async () => ({
      files: { get: async () => ({ data: { name: "folder" } }) },
    }),
    "../util/checkWeCanContinue": () => canContinue,
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
    "./util/localReaddir": async () => [],
    "./util/transformDriveItems": require("../sync/util/transformDriveItems"),
    "./util/truncateToSecond": require("../sync/util/truncateToSecond"),
    "./util/limiter": require("../sync/util/limiter"),
    "./util/comparePaths": require("../sync/util/comparePaths"),
  };

  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../sync/sync"), "utf8"), {
    module,
    exports: module.exports,
    console: { log() {}, error() {} },
    require: (name) => (name in stubs ? stubs[name] : require(name)),
  });

  state.run = () =>
    module.exports(
      "blog",
      () => {},
      async (path) => {
        state.events.push("update start " + path);
        state.runningUpdates += 1;
        state.maxRunningUpdates = Math.max(
          state.maxRunningUpdates,
          state.runningUpdates
        );
        await gate(state.updateGates, path);
        state.runningUpdates -= 1;
        state.events.push("update end " + path);
      }
    );
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("google-drive sync() overlaps downloads with builds", function () {
  it("starts the next download while the previous file builds, and builds one at a time in order", async function () {
    const h = harness(3);
    const done = h.run();

    await settle();
    // Every download has started, though nothing has finished
    expect(h.events).toEqual([
      "download start 0",
      "download start 1",
      "download start 2",
    ]);

    h.downloadGates.get("0")();
    await settle();
    expect(h.events).toContain("update start /file0.txt");

    // The second and third downloads finish while the first build is open
    h.downloadGates.get("1")();
    h.downloadGates.get("2")();
    await settle();
    expect(h.events).toContain("download end 1");
    expect(h.events).toContain("download end 2");
    expect(h.events).not.toContain("update start /file1.txt");
    expect(h.events).not.toContain("update end /file0.txt");

    for (const path of ["/file0.txt", "/file1.txt", "/file2.txt"]) {
      await settle();
      h.updateGates.get(path)();
    }

    const summary = await done;
    expect(summary.downloaded).toBe(3);
    expect(h.maxRunningUpdates).toBe(1);
    expect(h.events.filter((event) => event.startsWith("update "))).toEqual([
      "update start /file0.txt",
      "update end /file0.txt",
      "update start /file1.txt",
      "update end /file1.txt",
      "update start /file2.txt",
      "update end /file2.txt",
    ]);
    // Recorded as applied only after each file's own build
    expect(h.applied).toEqual(["0", "1", "2"]);
  });

  it("runs at most four downloads at once", async function () {
    const h = harness(6);
    const done = h.run();

    await settle();
    expect(h.events.filter((e) => e.startsWith("download start")).length).toBe(
      4
    );

    for (let i = 0; i < 6; i++) {
      await settle();
      h.downloadGates.get(String(i))();
      await settle();
      h.updateGates.get("/file" + i + ".txt")();
    }
    await done;
    expect(h.events.filter((e) => e.startsWith("download start")).length).toBe(
      6
    );
  });

  it("starts no download once the sync cannot continue, and applies none", async function () {
    let calls = 0;
    const h = harness(6, {
      canContinue: async () => {
        calls += 1;
        // The first four downloads start; the folder changes after that
        if (calls > 4) throw new Error("Folder ID changed");
      },
    });
    const done = h.run();

    await settle();
    expect(h.events.filter((e) => e.startsWith("download start")).length).toBe(
      4
    );

    h.downloadGates.get("0")();
    await settle();
    // The 5th download is next in line and is refused
    expect(h.events).not.toContain("download start 4");
    expect(await done).toBe(false);
    expect(h.events.some((e) => e.startsWith("update start"))).toBe(false);
    expect(h.applied).toEqual([]);
  });
});
