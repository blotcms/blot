const fs = require("fs");
const vm = require("vm");

// Loads sync/index.js with its dependencies stubbed. events records the order
// things happen in.
function load({ account, storeError }) {
  const module = { exports: {} };
  const events = [];
  const stored = [];

  const stubs = {
    "helper/clfdate": () => "",
    "sync/establishSyncLock": async () => {
      events.push("lock");
      return {
        folder: { status() {}, update() {} },
        done: async () => events.push("release"),
      };
    },
    "../database": {
      blog: {
        get: async () => account,
        store: async (blogID, data) => {
          events.push("store");
          if (storeError) throw storeError;
          stored.push({ blogID, data });
        },
      },
    },
    "./sync.js": async () => {
      events.push("walk");
      return { downloaded: 0, removed: 0, createdDirs: 0 };
    },
  };

  vm.runInNewContext(fs.readFileSync(require.resolve("../sync/index"), "utf8"), {
    module,
    exports: module.exports,
    console: { log() {}, error() {} },
    require: (name) =>
      Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : require(name),
  });

  return { sync: module.exports, events, stored };
}

describe("google drive sync entry point", function () {
  it("stamps lastSync before taking the lock", async function () {
    const before = Date.now();
    const { sync, events, stored } = load({ account: { folderId: "folder" } });

    await sync("blog_a");

    expect(events).toEqual(["store", "lock", "walk", "release"]);
    expect(stored.length).toBe(1);
    expect(stored[0].blogID).toBe("blog_a");
    expect(stored[0].data.lastSync).not.toBeLessThan(before);
    expect(stored[0].data.lastSync).not.toBeGreaterThan(Date.now());
  });

  it("still syncs when the stamp can't be written", async function () {
    const { sync, events } = load({
      account: { folderId: "folder" },
      storeError: new Error("redis down"),
    });

    const summary = await sync("blog_a");

    expect(summary).toBeTruthy();
    expect(events).toEqual(["store", "lock", "walk", "release"]);
  });

  it("does not stamp a blog with no folder", async function () {
    const { sync, events } = load({ account: { folderId: null } });

    await sync("blog_a");

    expect(events).toEqual([]);
  });
});
