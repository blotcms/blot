const fs = require("fs");
const vm = require("vm");

// Loads sync/index.js with its dependencies stubbed. events records the order
// things happen in. detections are what each detecting walk finds, in turn
// (default: nothing).
function load({
  account,
  storeError,
  detections = [],
  walkLocked = false,
  rewalkAfter = 0,
  // Directories changes.list and the search recorded before the sync
  recorded = [],
  // The blog's recently changed directories, and which of them differ
  hot = [],
  hotChanged = [],
  // Resolves when the check of the recent directories may finish
  hotGate = Promise.resolve(),
} = {}) {
  const module = { exports: {} };
  const events = [];
  const stored = [];
  const dirty = new Set(recorded);
  const applyOptions = [];
  let rewalks = rewalkAfter;
  let detectCount = 0;

  const stubs = {
    "helper/clfdate": () => "",
    "helper/lock": async () => {
      if (walkLocked)
        throw Object.assign(new Error("locked"), { code: "ELOCKED" });
      events.push("walk-lock");
      return { release: async () => events.push("walk-release") };
    },
    "models/client": {
      set: async (key) => events.push("set " + key),
      del: async () => {},
      // A request arrives during each of the first `rewalkAfter` walks
      getDel: async () => (rewalks-- > 0 ? "1" : null),
    },
    "../database/prefix": "p:",
    "sync/establishSyncLock": async () => {
      events.push("lock");
      return {
        folder: {
          status() {},
          update() {},
          signal: new AbortController().signal,
          run: (fn) => fn(),
        },
        done: async () => events.push("release"),
      };
    },
    "../database": {
      blog: {
        get: async () => account,
        update: async (blogID, data) => {
          events.push("store");
          if (storeError) throw storeError;
          stored.push({ blogID, data });
        },
      },
      dirty: {
        FULL: "*",
        add: async (blogID, ids) => ids.forEach((id) => dirty.add(id)),
        count: async () => dirty.size,
      },
      recent: {
        touch: async () => {},
        list: async () => hot.map((dirId) => ({ blogID: "blog_a", dirId })),
      },
    },
    "./sync.js": async (blogID, publish, update, options) => {
      if (options.only) {
        events.push("hot " + options.only.join(","));
        await hotGate;
        events.push("hot done");
        return { changed: hotChanged, paths: [], full: false };
      }
      if (options.detectOnly) {
        events.push("detect");
        const found = detections[detectCount++];
        if (found === false) return false;
        // A detection that made way: changes.list recorded a directory
        if (found && found.yielded) dirty.add("recorded_meanwhile");
        return found || { changed: [], full: false };
      }
      events.push("apply");
      applyOptions.push(options);
      dirty.clear();
      return { downloaded: 1, removed: 0, createdDirs: 0 };
    },
  };

  vm.runInNewContext(
    fs.readFileSync(require.resolve("../sync/index"), "utf8"),
    {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      require: (name) =>
        Object.prototype.hasOwnProperty.call(stubs, name)
          ? stubs[name]
          : require(name),
    }
  );

  return { sync: module.exports, events, stored, dirty, applyOptions };
}

const folder = { folderId: "folder" };

describe("google drive sync entry point", function () {
  it("leaves the folder alone while setup copies the site's files into it", async function () {
    const { sync, events } = load({
      account: { folderId: "folder", preparing: true },
    });

    expect(await sync("blog_a")).toBeUndefined();

    expect(events).toEqual([]);
  });

  it("stamps lastSync, then walks without the folder lock when nothing changed", async function () {
    const before = Date.now();
    const { sync, events, stored } = load({ account: folder });

    expect(await sync("blog_a")).toBeTruthy();

    expect(events).toEqual(["store", "walk-lock", "detect", "walk-release"]);
    expect(stored.length).toBe(1);
    expect(stored[0].blogID).toBe("blog_a");
    expect(stored[0].data.lastSync).not.toBeLessThan(before);
    expect(stored[0].data.lastSync).not.toBeGreaterThan(Date.now());
  });

  it("takes the folder lock only to apply what changed, then checks again", async function () {
    const { sync, events, applyOptions } = load({
      account: folder,
      detections: [{ changed: ["dir_a"], full: false }],
    });

    const summary = await sync("blog_a");

    expect(summary.downloaded).toBe(1);
    expect(events).toEqual([
      "store",
      "walk-lock",
      "detect",
      "lock",
      "apply",
      "release",
      "detect",
      "walk-release",
    ]);
    expect(applyOptions[0].fullWalk).toBe("if-asked");
  });

  it("applies directories already recorded as changed before walking", async function () {
    const { sync, events } = load({ account: folder, recorded: ["dir_a"] });

    const summary = await sync("blog_a");

    expect(summary.downloaded).toBe(1);
    expect(events).toEqual([
      "store",
      "walk-lock",
      "lock",
      "apply",
      "release",
      "detect",
      "walk-release",
    ]);
  });

  it("applies directories recorded during a detection, then detects again", async function () {
    const { sync, events } = load({
      account: folder,
      detections: [{ yielded: true }],
    });

    await sync("blog_a");

    expect(events).toEqual([
      "store",
      "walk-lock",
      "detect",
      "lock",
      "apply",
      "release",
      "detect",
      "walk-release",
    ]);
  });

  it("applies again what still differs after an apply", async function () {
    const { sync, events } = load({
      account: folder,
      detections: [
        { changed: ["dir_a"], full: false },
        { changed: ["dir_a"], full: false },
      ],
    });

    await sync("blog_a");

    expect(events.filter((e) => e === "apply").length).toBe(2);
  });

  it("asks for a full walk when the mapping has drifted", async function () {
    const { sync, dirty, events } = load({
      account: folder,
      detections: [{ changed: [], full: true }],
    });
    const seen = [];
    const add = dirty.add.bind(dirty);
    dirty.add = (id) => {
      seen.push(id);
      return add(id);
    };

    await sync("blog_a");

    expect(seen).toEqual(["*"]);
    expect(events).toContain("apply");
  });

  it("walks under the folder lock, as before, when a detection fails", async function () {
    const { sync, events, applyOptions } = load({
      account: folder,
      detections: [false],
    });

    await sync("blog_a");

    expect(events).toEqual([
      "store",
      "walk-lock",
      "detect",
      "lock",
      "apply",
      "release",
      "walk-release",
    ]);
    expect(applyOptions[0].fullWalk).toBe("always");
  });

  it("asks the process walking the blog to walk again, and rejects as locked", async function () {
    const { sync, events } = load({ account: folder, walkLocked: true });

    let rejected = null;
    try {
      await sync("blog_a", { rethrowLocked: true });
    } catch (err) {
      rejected = err;
    }
    expect(rejected && rejected.message).toBe("Failed to acquire folder lock");
    expect(events).toContain("set p:rewalk:blog_a");
    expect(await sync("blog_a")).toBe(false);
  });

  it("walks again for requests that arrived during a walk", async function () {
    const { sync, events } = load({ account: folder, rewalkAfter: 2 });

    await sync("blog_a");

    expect(events.filter((e) => e === "detect").length).toBe(3);
  });

  it("walks again at most five times in a row", async function () {
    const { sync, events } = load({ account: folder, rewalkAfter: 100 });

    await sync("blog_a");

    expect(events.filter((e) => e === "detect").length).toBe(5);
  });

  it("still syncs when the stamp can't be written", async function () {
    const { sync, events } = load({
      account: folder,
      storeError: new Error("redis down"),
    });

    expect(await sync("blog_a")).toBeTruthy();
    expect(events).toEqual(["store", "walk-lock", "detect", "walk-release"]);
  });

  it("does not stamp a blog with no folder", async function () {
    const { sync, events } = load({ account: { folderId: null } });

    await sync("blog_a");

    expect(events).toEqual([]);
  });

  it("checks the recently changed directories beside the full detection, and applies what differs", async function () {
    const { sync, events } = load({
      account: { folderId: "folder", serviceAccountId: "sa" },
      hot: ["dir_a", "dir_b"],
      hotChanged: ["dir_b"],
    });

    await sync("blog_a");

    // The two run side by side
    expect(events).toContain("hot dir_a,dir_b");
    expect(events.indexOf("apply")).toBeGreaterThan(events.indexOf("detect"));
  });

  it("only runs the full detection when nothing changed recently", async function () {
    const { sync, events } = load({ account: folder });

    expect(await sync("blog_a")).toBeTruthy();
    expect(events).toEqual(["store", "walk-lock", "detect", "walk-release"]);
  });

  it("applies what the full detection found without waiting for the recent directories' check", async function () {
    let open;
    const hotGate = new Promise((resolve) => (open = resolve));
    const { sync, events } = load({
      account: { folderId: "folder", serviceAccountId: "sa" },
      detections: [{ changed: ["dir_c"], full: false }],
      hot: ["dir_a"],
      hotChanged: ["dir_a"],
      hotGate,
    });

    const syncing = sync("blog_a");
    while (!events.includes("apply"))
      await new Promise((resolve) => setImmediate(resolve));
    expect(events).not.toContain("hot done");
    open();
    await syncing;

    // Then what the check found is applied too
    expect(events.filter((e) => e === "apply").length).toBe(2);
    expect(events.indexOf("hot done")).toBeLessThan(
      events.lastIndexOf("apply")
    );
  });
});
