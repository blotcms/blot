const fs = require("fs-extra");
const vm = require("vm");
const { SimpleError } = require("redis");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// What a sync does about the commit Blot last applied, which it records in
// Redis: it moves only once every path has been processed, so whatever
// interrupts a sync (Redis being unavailable, a crash) leaves the next sync
// to apply the same paths again.
describe("Git sync when Redis is unavailable", function () {
  let updates;
  let released;
  let failing;
  let logs;
  let applied;
  let writes;
  let readError;
  let writeError;
  let master;
  let emptyDiff;
  let crash;
  let materialized;
  let materializeError;

  // The commits the store has
  const known = ["old", "new"];
  const EMPTY_TREE = "nothing";
  const unavailable = () =>
    new SimpleError("NOREPLICAS Not enough good replicas to write.");

  beforeEach(function () {
    updates = [];
    released = 0;
    failing = {};
    logs = [];
    applied = "old";
    writes = 0;
    readError = null;
    writeError = null;
    master = "old";
    emptyDiff = false;
    crash = null;
    materialized = [];
    materializeError = null;
  });

  // Loads a module of the git client in a context of its own, with some of
  // what it requires replaced
  function load(file, stubs) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve(file), "utf8"), {
      module,
      exports: module.exports,
      console,
      require: (name) => (name in stubs ? stubs[name] : require(name)),
    });
    return module.exports;
  }

  // Runs sync.js and served/sync.js with the store, the materializer and the
  // database faked. A push moves master in the store from "old" to "new",
  // which changes a.txt and b.txt.
  async function run({ push }) {
    if (push) master = "new";

    const served = load("../served/sync", {
      "../database": {
        getApplied: async () => {
          if (readError) throw readError;
          return applied;
        },
        setApplied: async (id, commit) => {
          if (writeError) throw writeError;
          writes++;
          applied = commit;
        },
      },
      "../store/manifest": {
        read: async () => ({ refs: { "refs/heads/master": master } }),
        isEmpty: () => false,
      },
      "../store/reader": () => ({
        read: async (oid) => {
          if (known.includes(oid)) return { type: "commit" };
          throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
        },
      }),
      "./materialize": Object.assign(
        async ({ from, to }) => {
          materialized.push([from, to]);
          if (materializeError) throw materializeError;
          return emptyDiff ? [] : ["a.txt", "b.txt"];
        },
        { EMPTY_TREE }
      ),
      "./context": { storeFor: () => ({}), cache: () => ({}) },
    });

    return new Promise((resolve) => {
      const sync = load("../sync", {
        sync: (id, cb) =>
          cb(
            null,
            {
              log(message) {
                logs.push(message);
              },
              update(path, callback) {
                updates.push(path);
                if (crash === path) return resolve("crashed");
                callback(failing[path] || null);
              },
            },
            (err, cb) => {
              released++;
              cb(err);
            }
          ),
        "./served/sync": served,
      });

      sync("test", "test", resolve);
    });
  }

  it("applies the paths Redis refused on the next sync, even with no new push", async function () {
    failing["b.txt"] = unavailable();

    const error = await run({ push: true });

    expect(isRedisUnavailableError(error)).toBe(true);
    expect(released).toBe(1);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("old");
    expect(writes).toBe(0);

    // The freeze is over and nothing was pushed since
    failing = {};
    updates = [];

    expect(await run({ push: false })).toBe(null);
    expect(released).toBe(2);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("applies the paths of an interrupted sync on the next sync, after a crash", async function () {
    crash = "b.txt";

    expect(await run({ push: true })).toBe("crashed");
    expect(applied).toBe("old");

    crash = null;
    updates = [];

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("applies the paths of an earlier push along with a later one", async function () {
    failing["a.txt"] = unavailable();
    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);

    failing = {};
    updates = [];

    // The next push is compared with what was applied
    expect(await run({ push: true })).toBe(null);
    expect(materialized.pop()).toEqual(["old", "new"]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("fails rather than treat an unreadable commit as a missing one", async function () {
    readError = unavailable();

    const error = await run({ push: true });

    expect(isRedisUnavailableError(error)).toBe(true);
    expect(released).toBe(1);
    expect(updates).toEqual([]);
    expect(writes).toBe(0);
  });

  it("fails if Redis will not take the commit, and applies the paths again", async function () {
    writeError = unavailable();

    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("old");

    writeError = null;
    updates = [];

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("keeps going past other errors, and records the commit", async function () {
    spyOn(console, "log");
    failing["a.txt"] = new Error("this file is broken");

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("compares from nothing when no commit is recorded", async function () {
    applied = null;

    expect(await run({ push: true })).toBe(null);
    expect(materialized).toEqual([[EMPTY_TREE, "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("starts from nothing again if a sync from nothing was interrupted", async function () {
    applied = null;
    failing["b.txt"] = unavailable();

    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);
    expect(applied).toBe(EMPTY_TREE);

    failing = {};
    updates = [];
    materialized = [];

    expect(await run({ push: false })).toBe(null);
    expect(materialized).toEqual([[EMPTY_TREE, "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("compares from nothing when the store has lost the recorded commit", async function () {
    applied = "gone";

    expect(await run({ push: true })).toBe(null);
    expect(materialized).toEqual([[EMPTY_TREE, "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
    expect(logs.join("\n")).toContain("gone is not in the store");
  });

  it("fails, and keeps the recorded commit, if the blog folder cannot be updated", async function () {
    materializeError = new Error("disk full");

    const error = await run({ push: true });

    expect(error.message).toBe("disk full");
    expect(released).toBe(1);
    expect(updates).toEqual([]);
    expect(applied).toBe("old");

    materializeError = null;
    materialized = [];

    expect(await run({ push: false })).toBe(null);
    expect(materialized).toEqual([["old", "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("does nothing, and writes nothing, when the recorded commit is master", async function () {
    applied = "new";
    master = "new";

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual([]);
    expect(materialized).toEqual([]);
    expect(writes).toBe(0);
  });

  it("records the new commit when it changes no paths", async function () {
    emptyDiff = true;

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual([]);
    expect(applied).toBe("new");
  });
});
