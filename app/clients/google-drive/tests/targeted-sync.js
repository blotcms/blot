const fs = require("fs");
const vm = require("vm");

const FOLDER = "application/vnd.google-apps.folder";

// The root holds directories d00..d09 (ids dir-0..dir-9), each with a.txt
// and b.txt. `local` says which paths already exist in the blog folder as
// directories; files never do, so every file is downloaded and applied.
function tree() {
  const dirs = { root: [] };
  for (let i = 0; i < 10; i++) {
    const id = "dir-" + i;
    dirs.root.push({ id, name: "d0" + i, mimeType: FOLDER });
    dirs[id] = [
      { id: id + "-a", name: "a.txt", mimeType: "text/plain", size: 1 },
      { id: id + "-b", name: "b.txt", mimeType: "text/plain", size: 1 },
    ];
  }
  return dirs;
}

const pathOf = (id) => (id === "root" ? "/" : "/d0" + id.replace("dir-", ""));

function harness({
  dirs = tree(),
  local = [],
  dirty = [],
  count = async () => 0,
  failOn = null,
  rootDelay = 2,
} = {}) {
  const state = {
    listed: [],
    updates: [],
    taken: [],
    takenAt: [],
    putBack: [],
  };
  const queue = [dirty];

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
        get: async (id) => (id in dirs ? pathOf(id) : null),
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
    "./util/driveReaddir": async (drive, dirId) => {
      state.listed.push(dirId);
      await new Promise((resolve) =>
        setTimeout(resolve, dirId === "root" ? rootDelay : 2)
      );
      if (dirId === failOn) throw new Error("Listing failed");
      return (dirs[dirId] || []).map((item) => ({
        modifiedTime: "2026-01-01T00:00:00Z",
        md5Checksum: "md5-" + item.id,
        ...item,
      }));
    },
    "./util/localReaddir": async (blogID, dir) =>
      local
        .filter((path) => path.startsWith(dir === "/" ? "/" : dir + "/"))
        .filter((path) => !path.slice(dir.length + 1).includes("/"))
        .map((path) => ({
          name: path.split("/").pop(),
          isDirectory: true,
        })),
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
      },
      {
        dirty: {
          FULL: "*",
          take: async () => {
            const ids = queue.shift() || [];
            state.taken.push(ids);
            state.takenAt.push(state.listed.length);
            return ids;
          },
          count,
          putBack: async (ids) => state.putBack.push(...ids),
        },
      }
    );
  state.queue = queue;
  return state;
}

const allDirs = Array.from({ length: 10 }, (_, i) => "/d0" + i);

describe("google-drive sync() with changed directories", function () {
  it("lists and applies the changed directory before the full walk", async function () {
    const h = harness({ local: allDirs, dirty: ["dir-5"] });
    const summary = await h.run();

    expect(summary).toBeTruthy();
    expect(h.listed[0]).toBe("dir-5");
    expect(h.updates.slice(0, 2)).toEqual(["/d05/a.txt", "/d05/b.txt"]);
    // The full walk still follows, from the top
    expect(h.listed[1]).toBe("root");
    expect(h.listed.length).toBe(12);
  });

  it("doesn't walk below a changed directory, except into directories it creates", async function () {
    // d03 is new: not in the blog folder yet
    const h = harness({
      local: allDirs.filter((path) => path !== "/d03"),
      dirty: ["root"],
    });
    await h.run();

    // The targeted pass lists the root and the new d03 only
    expect(h.listed.slice(0, 2)).toEqual(["root", "dir-3"]);
    expect(h.updates.slice(0, 3)).toEqual(["/d03", "/d03/a.txt", "/d03/b.txt"]);
    expect(h.listed[2]).toBe("root");
  });

  it("does only the full walk when asked for one", async function () {
    const h = harness({ local: allDirs, dirty: ["*"] });
    await h.run();

    expect(h.listed[0]).toBe("root");
    expect(h.listed.length).toBe(11);
  });

  it("skips a changed directory the mapping no longer has", async function () {
    const h = harness({ local: allDirs, dirty: ["gone"] });
    const summary = await h.run();

    expect(summary).toBeTruthy();
    expect(h.listed).not.toContain("gone");
  });

  it("makes way for directories that change during the full walk", async function () {
    let changedOnce = false;
    const h = harness({
      local: allDirs,
      dirty: [],
      // A change arrives once the walk is under way
      count: async () => {
        if (changedOnce) return 0;
        changedOnce = true;
        h.queue.push(["dir-7"]);
        return 1;
      },
    });
    await h.run();

    // The walk stopped, the changed directory was listed, then a full walk
    const at = h.takenAt[1];
    expect(h.listed[at]).toBe("dir-7");
    expect(h.listed[at + 1]).toBe("root");
    expect(h.taken).toEqual([[], ["dir-7"]]);
  });

  it("stops making way after five times, so the walk finishes", async function () {
    // Each walk takes longer than the 250ms between checks
    const h = harness({ local: allDirs, count: async () => 1, rootDelay: 300 });
    const summary = await h.run();

    expect(summary).toBeTruthy();
    expect(h.taken.length).toBe(6);
    expect(h.listed.filter((id) => id === "root").length).toBe(6);
  });

  it("puts what it took back when the sync fails", async function () {
    const h = harness({ local: allDirs, dirty: ["dir-2"], failOn: "dir-2" });

    expect(await h.run()).toBe(false);
    expect(h.putBack).toEqual(["dir-2"]);
  });
});
