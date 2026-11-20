const fs = require("fs");
const vm = require("vm");

const FOLDER = "application/vnd.google-apps.folder";

// A Drive tree: the root holds `width` directories d00, d01, ..., each with two
// files, and d00 also holds a subdirectory with one file.
function tree(width) {
  const dirs = { root: [] };
  const name = (i) => "d" + String(i).padStart(2, "0");
  for (let i = 0; i < width; i++) {
    const id = "dir-" + i;
    dirs.root.push({ id, name: name(i), mimeType: FOLDER });
    dirs[id] = [
      { id: id + "-a", name: "a.txt", mimeType: "text/plain", size: 1 },
      { id: id + "-b", name: "b.txt", mimeType: "text/plain", size: 1 },
    ];
  }
  dirs["dir-0"].push({ id: "sub", name: "sub", mimeType: FOLDER });
  dirs.sub = [{ id: "sub-a", name: "c.txt", mimeType: "text/plain", size: 1 }];
  return dirs;
}

// Runs the real sync.js with its collaborators stubbed, listing `dirs`.
// Every file is missing locally, so each is downloaded and applied, and the
// order of update() calls shows the order the walk applied things in.
function harness(dirs, { listDelay = 5, failOn = null } = {}) {
  const state = { listed: [], running: 0, maxRunning: 0, updates: [] };

  const list = async (drive, dirId) => {
    state.listed.push(dirId);
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    await new Promise((resolve) => setTimeout(resolve, listDelay));
    state.running -= 1;
    if (dirId === failOn) throw new Error("Listing failed");
    // Fresh objects each time: the walk renames items in place
    return (dirs[dirId] || []).map((item) => ({
      modifiedTime: "2026-01-01T00:00:00Z",
      md5Checksum: "md5-" + item.id,
      ...item,
    }));
  };

  const stubs = {
    "storage/folder": { remove: async () => {}, mkdir: async () => {} },
    "../database": {
      blog: {
        get: async () => ({
          folderId: "root",
          folderName: "root",
          serviceAccountId: "service",
        }),
      },
      folder: () => ({
        get: async () => null,
        getByPath: async () => null,
        set: async () => {},
        remove: async () => {},
        getVerifiedContents: async (ids) => ids.map(() => undefined),
        setVerifiedContent: async () => {},
        getApplied: async () => null,
        setApplied: async () => {},
      }),
    },
    "../util/localState": {
      stamp: require("../util/localState").stamp,
      unchanged: async () => null,
      stateOf: async () => ({ size: 1, modified: 1000, sha1: "sha1" }),
    },
    "../util/download": async () => ({ updated: true }),
    "../serviceAccount/createDriveClient": async () => ({
      files: { get: async () => ({ data: { name: "root" } }) },
    }),
    "../util/checkWeCanContinue": () => async () => {},
    "clients/util/shouldIgnoreFile": () => false,
    "clients/util/modifiedSince": require("../../util/modifiedSince"),
    "clients/util/localDescendants": async () => [],
    "clients/util/resyncProgress": {
      countLocalFiles: async () => 0,
      createProgress: () => ({
        publish() {},
        publishThrottled() {},
        discover() {},
        finish() {},
      }),
    },
    "./util/driveReaddir": list,
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
        state.updates.push(path);
      }
    );
  return state;
}

// What a walk listing one directory at a time applies, in order
function depthFirst(dirs, dirId = "root", dir = "") {
  const sorted = [...dirs[dirId]].sort((a, b) =>
    require("../sync/util/comparePaths")(a.name, b.name)
  );
  const paths = [];
  for (const item of sorted) {
    const path = dir + "/" + item.name;
    paths.push(path);
    if (item.mimeType === FOLDER)
      paths.push(...depthFirst(dirs, item.id, path));
  }
  return paths;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("google-drive sync() lists directories ahead of the walk", function () {
  it("lists several directories at once, at most sixteen", async function () {
    const h = harness(tree(40));
    const summary = await h.run();

    expect(summary).toBeTruthy();
    expect(h.maxRunning).toBeGreaterThan(4);
    expect(h.maxRunning).toBeLessThanOrEqual(16);
  });

  it("applies everything in the same order as a walk listing one directory at a time", async function () {
    const dirs = tree(40);
    const h = harness(dirs);
    await h.run();

    expect(h.updates).toEqual(depthFirst(dirs));
  });

  it("lists each directory once, and nothing after the sync has finished", async function () {
    const dirs = tree(40);
    const h = harness(dirs);
    await h.run();
    const listed = [...h.listed];
    await settle();

    expect(h.listed).toEqual(listed);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(Object.keys(dirs).sort());
  });

  it("fails the sync when a directory can't be listed, as before", async function () {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness(tree(40), { failOn: "dir-30" });
      expect(await h.run()).toBe(false);
      // Directories after the failed one are never applied
      expect(h.updates).not.toContain("/d31");
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("works for a folder with no subdirectories", async function () {
    const dirs = {
      root: [{ id: "f", name: "f.txt", mimeType: "text/plain", size: 1 }],
    };
    const h = harness(dirs);
    await h.run();

    expect(h.updates).toEqual(["/f.txt"]);
    expect(h.listed).toEqual(["root"]);
  });
});
