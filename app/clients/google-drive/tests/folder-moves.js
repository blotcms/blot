const fs = require("fs");
const vm = require("vm");

const FOLDER = "application/vnd.google-apps.folder";

// Runs the real sync.js against an in-memory blog folder and folder mapping.
// remote: Drive as { dirId: [items] }; local: the blog folder's paths (a
// trailing "/" marks a directory); mapping: id -> path.
function harness({ remote, local, mapping, hints = {}, failUpdate = null }) {
  const files = new Set(local);
  const paths = new Map(Object.entries(mapping));
  // The SHA-1 of the bytes at each path in the blog folder, which a move
  // carries along, and Drive's md5Checksum paired with each SHA-1
  // (util/hashes.js)
  const sha1s = new Map();
  const pairs = new Map();
  const state = {
    downloads: [],
    updates: [],
    moves: [],
    removes: [],
    files,
    failUpdate,
  };

  const isDir = (path) => files.has(path + "/");
  const exists = (path) => path === "/" || files.has(path) || isDir(path);
  const children = (dir) =>
    [...files]
      .map((path) => path.replace(/\/$/, ""))
      .filter(
        (path) =>
          path.startsWith(dir === "/" ? "/" : dir + "/") &&
          !path.slice(dir === "/" ? 1 : dir.length + 1).includes("/")
      );
  const below = (dir) =>
    [...files]
      .map((path) => path.replace(/\/$/, ""))
      .filter((path) => path.startsWith(dir + "/"));
  const idOf = (path) => [...paths].find(([, p]) => p === path)?.[0] || null;

  // Every file starts verified, so nothing needs downloading
  for (const [id, path] of paths) {
    if (files.has(path)) {
      sha1s.set(path, "sha1-" + id);
      pairs.set("sha1-" + id, "md5-" + id);
    }
  }

  const stubs = {
    "storage/folder": {
      exists: async (blogID, path) => exists(path),
      mkdir: async (blogID, path) => files.add(path + "/"),
      remove: async (blogID, path) => {
        state.removes.push(path);
        for (const each of [path, ...below(path)]) {
          files.delete(each);
          files.delete(each + "/");
        }
      },
      move: async (blogID, from, to) => {
        state.moves.push([from, to]);
        for (const each of [from, ...below(from)]) {
          const moved = to + each.slice(from.length);
          if (files.delete(each + "/")) files.add(moved + "/");
          if (files.delete(each)) {
            files.add(moved);
            sha1s.set(moved, sha1s.get(each));
            sha1s.delete(each);
          }
        }
      },
      isPlaceholder: async () => false,
      stat: async (blogID, path) => ({
        isDirectory: isDir(path),
        sha1: sha1s.get(path),
      }),
    },
    "../database": {
      blog: {
        get: async () => ({
          folderId: "root",
          folderName: "root",
          serviceAccountId: "service",
        }),
      },
      folder: () => ({
        get: async (id) => paths.get(id) || null,
        getPaths: async (ids) => ids.map((id) => paths.get(id) || null),
        getByPath: async (path) => idOf(path),
        getIds: async (list) => list.map(idOf),
        set: async (id, path) => paths.set(id, path),
        remove: async (id) => {
          const from = paths.get(id);
          for (const [each, path] of [...paths])
            if (path === from || path.startsWith(from + "/"))
              paths.delete(each);
        },
        move: async (id, to) => {
          const from = paths.get(id);
          for (const [each, path] of [...paths])
            if (path === from || path.startsWith(from + "/"))
              paths.set(each, to + path.slice(from.length));
        },
        getApplied: async () => ({ modifiedTime: "2026-01-01T00:00:00Z" }),
        setApplied: async () => {},
      }),
    },
    "../util/hashes": {
      load: async () => ({
        get: (sha1) => pairs.get(sha1),
        set: (sha1, md5) => pairs.set(sha1, md5),
        async save() {},
      }),
    },
    "../util/localState": {
      unchanged: async () => true,
      stateOf: async () => ({ sha1: "s" }),
    },
    "../util/download": async (blogID, drive, path) => {
      state.downloads.push(path);
      files.add(path);
      sha1s.set(path, "downloaded");
      return { updated: true };
    },
    "../serviceAccount/createDriveClient": async () => ({
      files: { get: async () => ({ data: { name: "root" } }) },
    }),
    "../util/checkWeCanContinue": () => async () => {},
    "clients/util/shouldIgnoreFile": () => false,
    "clients/util/modifiedSince": require("../../util/modifiedSince"),
    "clients/util/localDescendants": async (blogID, path) => below(path),
    "clients/util/resyncProgress": {
      countLocalFiles: async () => 0,
      createProgress: () => ({
        publish() {},
        publishThrottled() {},
        discover() {},
        finish() {},
      }),
    },
    "./util/driveReaddir": async (drive, dirId) =>
      (remote[dirId] || []).map((item) => ({
        modifiedTime: "2026-01-01T00:00:00Z",
        md5Checksum: "md5-" + item.id,
        size: 1,
        mimeType: "text/plain",
        ...item,
      })),
    "./util/localReaddir": async (blogID, dir) =>
      children(dir).map((path) => ({
        name: path.split("/").pop(),
        isDirectory: isDir(path),
        size: 1,
        sha1: isDir(path) ? undefined : sha1s.get(path),
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

  const dirty = (ids) => {
    const queue = [ids];
    return {
      FULL: "*",
      take: async () => queue.shift() || [],
      count: async () => 0,
      members: async () => [],
      putBack: async () => {},
      moveHint: async (id) => hints[id] || null,
    };
  };

  const update = async (path) => {
    if (path === state.failUpdate) throw new Error("Redis went away");
    state.updates.push(path);
  };
  // A targeted pass of the given directories, as sync/index.js runs one
  state.apply = (ids) =>
    module.exports("blog", () => {}, update, {
      fullWalk: "if-asked",
      dirty: dirty(ids),
    });
  // The full walk under the lock, as the hourly check runs it
  state.walk = () => module.exports("blog", () => {}, update);
  state.paths = paths;
  state.pairs = pairs;
  return state;
}

const folderItem = (id, name) => ({ id, name, mimeType: FOLDER });
const fileItem = (id, name) => ({ id, name });

describe("google-drive sync() folder renames and moves", function () {
  it("moves a folder renamed in place, downloading nothing", async function () {
    const h = harness({
      remote: {
        root: [folderItem("F", "new")],
        F: [fileItem("a", "a.md"), fileItem("b", "b.md")],
      },
      local: ["/old/", "/old/a.md", "/old/b.md"],
      mapping: { root: "/", F: "/old", a: "/old/a.md", b: "/old/b.md" },
    });

    expect(await h.apply(["root"])).toBeTruthy();

    expect(h.moves).toEqual([["/old", "/new"]]);
    expect(h.removes).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect([...h.files].sort()).toEqual(["/new/", "/new/a.md", "/new/b.md"]);
    expect(h.paths.get("a")).toBe("/new/a.md");
    // Old and new paths are updated, so the posts move
    for (const path of ["/old", "/old/a.md", "/new", "/new/a.md", "/new/b.md"])
      expect(h.updates).toContain(path);
  });

  it("moves a folder to another folder when its old place is walked first, by changes.list's hint", async function () {
    const h = harness({
      remote: {
        root: [folderItem("A", "a"), folderItem("B", "b")],
        A: [],
        B: [folderItem("F", "f")],
        F: [fileItem("x", "x.md")],
      },
      local: ["/a/", "/b/", "/a/f/", "/a/f/x.md"],
      mapping: { root: "/", A: "/a", B: "/b", F: "/a/f", x: "/a/f/x.md" },
      hints: { F: "B" },
    });

    await h.apply(["A", "B"]);

    expect(h.moves).toEqual([["/a/f", "/b/f"]]);
    expect(h.downloads).toEqual([]);
    expect(h.files.has("/b/f/x.md")).toBe(true);
    expect(h.files.has("/a/f/x.md")).toBe(false);
  });

  it("moves a folder to another folder when its new place is walked first, with no hint", async function () {
    const h = harness({
      remote: {
        root: [folderItem("A", "a"), folderItem("B", "b")],
        A: [],
        B: [folderItem("F", "f")],
        F: [fileItem("x", "x.md")],
      },
      local: ["/a/", "/b/", "/a/f/", "/a/f/x.md"],
      mapping: { root: "/", A: "/a", B: "/b", F: "/a/f", x: "/a/f/x.md" },
    });

    await h.apply(["B", "A"]);

    expect(h.moves).toEqual([["/a/f", "/b/f"]]);
    expect(h.downloads).toEqual([]);
    expect(h.removes).toEqual([]);
  });

  it("moves a renamed folder in a full walk too", async function () {
    const h = harness({
      remote: {
        root: [folderItem("F", "new")],
        F: [fileItem("a", "a.md")],
      },
      local: ["/old/", "/old/a.md"],
      mapping: { root: "/", F: "/old", a: "/old/a.md" },
    });

    await h.walk();

    expect(h.moves).toEqual([["/old", "/new"]]);
    expect(h.downloads).toEqual([]);
  });

  it("creates a new folder at the old name of one renamed in the same pass", async function () {
    const h = harness({
      remote: {
        root: [folderItem("F", "a"), folderItem("G", "z")],
        F: [fileItem("x", "x.md")],
        G: [fileItem("y", "y.md")],
      },
      local: ["/z/", "/z/x.md"],
      mapping: { root: "/", F: "/z", x: "/z/x.md" },
    });

    expect(await h.apply(["root"])).toBeTruthy();

    expect(h.moves).toEqual([["/z", "/a"]]);
    expect(h.files.has("/a/x.md")).toBe(true);
    expect(h.files.has("/z/")).toBe(true);
    expect(h.downloads).toEqual(["/z/y.md"]);
  });

  it("rebuilds the moved files on the next walk when an update fails", async function () {
    const h = harness({
      remote: {
        root: [folderItem("F", "new")],
        F: [fileItem("a", "a.md")],
      },
      local: ["/old/", "/old/a.md"],
      mapping: { root: "/", F: "/old", a: "/old/a.md" },
      failUpdate: "/new/a.md",
    });

    expect(await h.apply(["root"])).toBe(false);

    expect(h.files.has("/new/a.md")).toBe(true);

    // The pair alone would say the file is unchanged, so it was unpaired:
    // the retry checks it through download(), which rebuilds it
    h.failUpdate = null;
    h.updates.length = 0;
    expect(await h.walk()).toBeTruthy();
    expect(h.updates).toContain("/new/a.md");
  });

  it("still removes a folder that is gone from Drive", async function () {
    const h = harness({
      remote: { root: [] },
      local: ["/old/", "/old/a.md"],
      mapping: { root: "/", F: "/old", a: "/old/a.md" },
    });

    await h.apply(["root"]);

    expect(h.moves).toEqual([]);
    expect(h.removes).toEqual(["/old"]);
  });

  it("removes and downloads as before when something is already where the folder went", async function () {
    const h = harness({
      remote: {
        root: [folderItem("F", "new")],
        F: [fileItem("a", "a.md")],
      },
      // Something unmapped already sits at the new name
      local: ["/old/", "/old/a.md", "/new/"],
      mapping: { root: "/", F: "/old", a: "/old/a.md" },
    });

    await h.apply(["root"]);

    expect(h.moves).toEqual([]);
    expect(h.removes).toContain("/old");
  });

  it("removes a folder moved out of the blog's folder", async function () {
    const h = harness({
      remote: { root: [folderItem("A", "a")], A: [] },
      local: ["/a/", "/a/f/", "/a/f/x.md"],
      mapping: { root: "/", A: "/a", F: "/a/f", x: "/a/f/x.md" },
      // Its new parent isn't in the blog
      hints: { F: "elsewhere" },
    });

    await h.apply(["A"]);

    expect(h.moves).toEqual([]);
    expect(h.removes).toEqual(["/a/f"]);
  });
});
