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

// The path of a file or directory in tree(): dir-3-a is /d03/a.txt
const itemPath = (id) => {
  const file = id.match(/^(dir-\d+)-(\w)$/);
  return file ? pathOf(file[1]) + "/" + file[2] + ".txt" : pathOf(id);
};

function harness({
  dirs = tree(),
  local = [],
  dirty = [],
  count = async () => 0,
  // What the dirty set holds while a pass runs; by default something new
  // whenever count says so
  members = null,
  failOn = null,
  rootDelay = 2,
  // Files the blog folder already holds, verified against Drive
  upToDate = [],
  // Ids the mapping has at another path
  drift = {},
  // Directory id -> { at, source }, as the dirty set's sightings
  seen = null,
} = {}) {
  const state = {
    listed: [],
    updates: [],
    updateOptions: [],
    taken: [],
    takenAt: [],
    putBack: [],
    writes: [],
    downloads: [],
  };
  const fresh = new Set(upToDate);
  const write = (name) => async (id) => state.writes.push(name + " " + id);
  const queue = [dirty];
  // What putBack returned, for the next take
  const pending = [];

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
        get: async (id) => drift[id] || (id in dirs ? pathOf(id) : null),
        getPaths: async (ids) => ids.map((id) => drift[id] || itemPath(id)),
        getByPath: async () => null,
        set: write("set"),
        remove: write("remove"),
        getApplied: async (id) =>
          fresh.has(itemPath(id))
            ? {
                modifiedTime: "2026-01-01T00:00:00Z",
                sha1: "sha1:" + itemPath(id),
              }
            : null,
        setApplied: write("setApplied"),
      }),
    },
    // An up-to-date file's SHA-1 ("sha1:" + its path) is paired with the
    // md5Checksum Drive lists for it ("md5-" + its id)
    "../util/hashes": {
      load: async () => ({
        get: (sha1) => {
          const path = sha1.slice("sha1:".length);
          const file = path.match(/^\/d0(\d)\/(\w)\.txt$/);
          return fresh.has(path) && file
            ? "md5-dir-" + file[1] + "-" + file[2]
            : undefined;
        },
        set() {},
        async save() {},
      }),
    },
    "../util/localState": {
      stamp: require("../util/localState").stamp,
      unchanged: async (blogID, path) =>
        fresh.has(path) ? { size: 1, modified: 1, sha1: "s" } : null,
      stateOf: async () => ({ size: 1, modified: 1000, sha1: "sha1" }),
    },
    "../util/download": async (blogID, drive, path) => {
      state.downloads.push(path);
      return { updated: true };
    },
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
        }))
        .concat(
          upToDate
            .filter((path) => path.startsWith(dir === "/" ? "/" : dir + "/"))
            .filter((path) => !path.slice(dir.length + 1).includes("/"))
            .map((path) => ({
              name: path.split("/").pop(),
              isDirectory: false,
              size: 1,
              sha1: "sha1:" + path,
            }))
        ),
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
            const ids = [...new Set([...(queue.shift() || []), ...pending])];
            pending.length = 0;
            state.taken.push(ids);
            state.takenAt.push(state.listed.length);
            return ids;
          },
          count,
          members:
            members || (async () => ((await count()) > 0 ? ["recorded"] : [])),
          putBack: async (ids) => {
            state.putBack.push(...ids);
            pending.push(...ids);
          },
        },
      }
    );
  state.queue = queue;
  // As sync/index.js applies what a detection found
  state.apply = () =>
    module.exports(
      "blog",
      () => {},
      async (path, options) => {
        state.updates.push(path);
        state.updateOptions.push(options);
      },
      {
        fullWalk: "if-asked",
        dirty: {
          FULL: "*",
          take: async () => {
            const ids = queue.shift() || [];
            state.taken.push(ids);
            return ids;
          },
          count,
          members:
            members || (async () => ((await count()) > 0 ? ["recorded"] : [])),
          putBack: async (ids) => state.putBack.push(...ids),
          ...(seen
            ? {
                seen: async (ids) =>
                  Object.fromEntries(
                    ids.filter((id) => seen[id]).map((id) => [id, seen[id]])
                  ),
              }
            : {}),
        },
      }
    );
  state.detect = (dirty) =>
    module.exports("blog", null, null, { detectOnly: true, dirty });
  state.detectOnly = (only) =>
    module.exports("blog", null, null, { detectOnly: true, only });
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

  it("makes way during a targeted pass, then finishes it after the new directories", async function () {
    let changedOnce = false;
    const h = harness({
      local: allDirs,
      dirty: ["dir-1", "dir-2"],
      count: async () => {
        if (changedOnce) return 0;
        changedOnce = true;
        h.queue.push(["dir-5"]);
        return 1;
      },
    });
    const summary = await h.run();

    expect(summary).toBeTruthy();
    // dir-1 was interrupted; dir-5 went first, then dir-1 and dir-2
    expect(h.putBack).toEqual(["dir-1", "dir-2"]);
    const after = h.listed.slice(h.takenAt[1]);
    expect(after.slice(0, 3)).toEqual(["dir-5", "dir-1", "dir-2"]);
  });

  it("doesn't make way for the directory it is applying, recorded again", async function () {
    const h = harness({
      local: allDirs,
      dirty: ["dir-1"],
      // A bulk upload: changes.list keeps recording the same directory
      members: async () => ["dir-1"],
      count: async () => 0,
    });
    const summary = await h.run();

    expect(summary).toBeTruthy();
    expect(h.putBack).toEqual([]);
    expect(h.taken.length).toBe(1);
  });

  it("applies what it took and returns, leaving what is recorded meanwhile to the next apply", async function () {
    const h = harness({
      local: allDirs,
      dirty: ["dir-1"],
      // A bulk upload into dir-1 keeps recording it
      members: async () => ["dir-1"],
      count: async () => 1,
    });
    h.queue.push(["dir-1"]);
    const summary = await h.apply();

    expect(summary).toBeTruthy();
    expect(h.taken).toEqual([["dir-1"]]);
    // No full walk, and the folder lock (held by the caller) is free again
    expect(h.listed).toEqual(["dir-1"]);
  });

  it("puts what it took back when the sync fails", async function () {
    const h = harness({ local: allDirs, dirty: ["dir-2"], failOn: "dir-2" });

    expect(await h.run()).toBe(false);
    expect(h.putBack).toEqual(["dir-2"]);
  });
});

// Every file of tree(), as the blog folder would hold it once synced
const everyFile = allDirs.flatMap((dir) => [dir + "/a.txt", dir + "/b.txt"]);

describe("google-drive sync() detecting what changed", function () {
  it("finds nothing in a blog that is up to date, and changes nothing", async function () {
    const h = harness({ local: allDirs, upToDate: everyFile });

    expect(await h.detect()).toEqual({ changed: [], paths: [], full: false });
    expect(h.writes).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("notes the directory of a missing file, without downloading it", async function () {
    const h = harness({
      local: allDirs,
      upToDate: everyFile.filter((path) => path !== "/d04/b.txt"),
    });

    expect(await h.detect()).toEqual({
      changed: ["dir-4"],
      paths: ["/d04"],
      full: false,
    });
    expect(h.downloads).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("notes the parent of a new directory, without walking into it", async function () {
    const h = harness({
      local: allDirs.filter((path) => path !== "/d06"),
      upToDate: everyFile.filter((path) => !path.startsWith("/d06/")),
    });

    // Only the root: d06 is created, and walked whole, when it is applied
    expect(await h.detect()).toEqual({
      changed: ["root"],
      paths: ["/"],
      full: false,
    });
  });

  it("notes the directory of a file the mapping has elsewhere", async function () {
    const h = harness({
      local: allDirs,
      upToDate: everyFile,
      drift: { "dir-2-a": "/old/a.txt" },
    });

    expect(await h.detect()).toEqual({
      changed: ["dir-2"],
      paths: ["/d02"],
      full: false,
    });
  });

  it("asks for a full walk when a directory's mapping has drifted", async function () {
    const h = harness({
      local: allDirs,
      upToDate: everyFile,
      drift: { "dir-8": "/elsewhere" },
    });

    expect((await h.detect()).full).toBe(true);
  });

  it("stops when changed directories are recorded while it walks", async function () {
    const h = harness({ local: allDirs, upToDate: everyFile });
    const result = await h.detect({ members: async () => ["dir-3"] });

    expect(result).toEqual({ yielded: true, changed: [], full: false });
  });

  it("resolves false when a listing fails", async function () {
    const h = harness({ local: allDirs, upToDate: everyFile, failOn: "dir-1" });

    expect(await h.detect()).toBe(false);
  });

  it("passes each file's sighting and download time to the update", async function () {
    const h = harness({
      local: allDirs,
      dirty: ["dir-5"],
      seen: { "dir-5": { at: 1234, source: "changes" } },
    });
    const before = Date.now();
    await h.apply();

    expect(h.updates[0]).toBe("/d05/a.txt");
    const options = h.updateOptions[0];
    expect(options.seenAt).toBe(1234);
    expect(options.seenBy).toBe("changes");
    expect(options.downloadedAt).not.toBeLessThan(before);
  });

  it("checks just the given directories, not below them, with only", async function () {
    const h = harness({
      local: allDirs,
      upToDate: everyFile.filter(
        (path) => path !== "/d04/b.txt" && path !== "/d07/a.txt"
      ),
    });

    expect(await h.detectOnly(["dir-4", "root"])).toEqual({
      changed: ["dir-4"],
      paths: ["/d04"],
      full: false,
    });
    // d07 differs too, but only a full detection reaches it
    expect(h.listed.sort()).toEqual(["dir-4", "root"]);
    expect(h.downloads).toEqual([]);
  });
});
