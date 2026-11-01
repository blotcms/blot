const fs = require("fs-extra");
const vm = require("vm");
const { SimpleError } = require("redis");
const validateTree = require("../validateTree");
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
  let head;
  let emptyDiff;
  let crash;
  let materialized;
  let materializeError;

  const known = ["old", "new"];
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
    head = "old";
    emptyDiff = false;
    crash = null;
    materialized = [];
    materializeError = null;
  });

  // Runs sync.js with the git commands faked. A push moves the remote from
  // "old" to "new" and changes a.txt and b.txt; with no push the remote stays
  // where the clone is. Resetting moves the clone's HEAD, as it does for real.
  // The repository has the commits in known, and no others.
  async function run({ push }) {
    const remote = push ? "new" : head;
    const git = {
      raw(args, cb) {
        let value = "";
        if (args[0] === "rev-parse" && args.includes("--quiet"))
          value = known.includes(args[3].replace("^{commit}", ""))
            ? args[3].replace("^{commit}", "")
            : "";
        else if (args[0] === "rev-parse" && args.includes("--verify")) value = remote;
        else if (args[0] === "rev-parse") value = head;
        else if (args[0] === "ls-tree") value = "100644 blob abc\tfile.txt\0";
        else if (args[0] === "reset") head = args[3];
        return cb ? cb(null, value) : Promise.resolve(value);
      },
    };

    return new Promise((resolve) => {
      const stubs = {
        "./git": () => git,
        debug: () => () => {},
        sync: (id, cb) =>
          cb(
            null,
            {
              path: "/not-used",
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
        "./checkGitRepoExists": (path, cb) => cb(null),
        "./repo": {
          directory: (handle) => "/not-used/" + handle + ".git",
          followLiveClone: (git, handle, commit, cb) =>
            git.raw(["reset", "--mixed", "--quiet", commit], cb),
        },
        "./materialize": Object.assign(
          (directory, folder, base, commit, cb) => {
            materialized.push([base, commit]);
            if (materializeError) return cb(materializeError);
            cb(null, emptyDiff ? [] : ["a.txt", "b.txt"]);
          },
          { EMPTY_TREE: "nothing" }
        ),
        "./database": {
          getApplied: (id, cb) => cb(readError, applied),
          setApplied: (id, commit, cb) => {
            if (writeError) return cb(writeError);
            writes++;
            applied = commit;
            cb(null);
          },
        },
        "models/blog": {},
        "./validateTree": validateTree,
      };
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(require.resolve("../sync"), "utf8"), {
        module,
        exports: module.exports,
        console,
        require: (name) => (name in stubs ? stubs[name] : require(name)),
      });
      module.exports("test", "test", resolve);
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

    // The freeze is over and nothing was pushed since: the clone has already
    // moved to the new commit, but the recorded one has not
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
    expect(head).toBe("new");
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

    // The next push is compared with what was applied, not with the clone
    expect(await run({ push: true })).toBe(null);
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

  it("compares from the clone before the pull when no commit is recorded", async function () {
    applied = null;

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("applies the paths Redis refused again when no commit was recorded", async function () {
    applied = null;
    failing["b.txt"] = unavailable();

    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);
    expect(applied).toBe("old");

    failing = {};
    updates = [];

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
  });

  it("compares from nothing when the repository has lost the clone's commit", async function () {
    applied = null;
    head = "lost";

    expect(await run({ push: true })).toBe(null);
    expect(materialized).toEqual([["nothing", "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
    expect(logs.join("\n")).toContain("lost is not in the repo");
  });

  it("starts from nothing again if a sync from nothing was interrupted", async function () {
    applied = null;
    head = "lost";
    failing["b.txt"] = unavailable();

    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);

    // The clone has moved on, but what was recorded has not
    expect(head).toBe("new");
    expect(applied).toBe("nothing");

    failing = {};
    updates = [];
    materialized = [];

    expect(await run({ push: false })).toBe(null);
    expect(materialized).toEqual([["nothing", "new"]]);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
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

  it("records the commit when none is recorded and nothing has changed", async function () {
    applied = null;

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual([]);
    expect(applied).toBe("old");
  });

  it("compares from the clone before the pull when the recorded commit has gone", async function () {
    applied = "gone";

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(applied).toBe("new");
    expect(logs.join("\n")).toContain("gone is not in the repo");
  });

  it("does nothing, and writes nothing, when the recorded commit is the new one", async function () {
    applied = "new";
    head = "new";

    expect(await run({ push: false })).toBe(null);
    expect(updates).toEqual([]);
    expect(writes).toBe(0);
  });

  it("records the new commit when it changes no paths", async function () {
    emptyDiff = true;

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual([]);
    expect(applied).toBe("new");
  });
});
