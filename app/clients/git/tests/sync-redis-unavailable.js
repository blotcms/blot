const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { SimpleError } = require("redis");
const validateTree = require("../validateTree");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

describe("Git sync when Redis is unavailable", function () {
  let folderPath;
  let updates;
  let released;
  let failing;

  beforeEach(function () {
    folderPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-sync-"));
    fs.ensureDirSync(folderPath + "/.git");
    updates = [];
    released = 0;
    failing = {};
  });

  afterEach(function () {
    fs.removeSync(folderPath);
  });

  // Runs sync.js with the git commands faked. A push moves HEAD from "old"
  // to "new" and changes a.txt and b.txt; with no push HEAD stays put.
  async function run({ push }) {
    let heads = 0;
    const git = {
      silent() { return this; },
      remote(args, cb) { cb(null); },
      fetch(args, cb) { cb(null); },
      raw(args, cb) {
        let value = "";
        if (args[0] === "rev-parse" && args.includes("--verify")) value = "validated";
        else if (args[0] === "rev-parse") value = push && heads++ > 0 ? "new" : "old";
        else if (args[0] === "ls-tree") value = "100644 blob abc\tfile.txt\0";
        else if (args[0] === "diff") value = "M\0a.txt\0M\0b.txt\0";
        return cb ? cb(null, value) : Promise.resolve(value);
      },
    };
    const stubs = {
      "simple-git": () => git,
      debug: () => () => {},
      sync: (id, cb) =>
        cb(
          null,
          {
            path: folderPath,
            log() {},
            update(path, callback) {
              updates.push(path);
              callback(failing[path] || null);
            },
          },
          (err, cb) => {
            released++;
            cb(err);
          }
        ),
      "./checkGitRepoExists": (path, cb) => cb(null),
      "./bareRepo": { directory: (handle) => "/test-data/" + handle + ".git" },
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
    return new Promise((resolve) => module.exports("test", "test", resolve));
  }

  const unappliedFile = () => folderPath + "/.git/blot-unapplied-paths.json";

  it("applies the paths Redis refused on the next sync, even with no new push", async function () {
    failing["b.txt"] = new SimpleError("NOREPLICAS Not enough good replicas to write.");

    const error = await run({ push: true });

    expect(isRedisUnavailableError(error)).toBe(true);
    expect(released).toBe(1);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(fs.readJsonSync(unappliedFile())).toEqual(["b.txt"]);

    // The freeze is over and nothing was pushed since: HEAD has not moved
    failing = {};
    updates = [];

    expect(await run({ push: false })).toBe(null);
    expect(released).toBe(2);
    expect(updates).toEqual(["b.txt"]);
    expect(fs.existsSync(unappliedFile())).toBe(false);
  });

  it("adds the paths of a later push to the ones left over", async function () {
    failing["a.txt"] = new SimpleError("NOREPLICAS Not enough good replicas to write.");

    expect(isRedisUnavailableError(await run({ push: true }))).toBe(true);
    expect(fs.readJsonSync(unappliedFile())).toEqual(["a.txt", "b.txt"]);

    failing = {};
    updates = [];

    // a.txt is in both the leftovers and the new diff, but updated once
    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(fs.existsSync(unappliedFile())).toBe(false);
  });

  it("fails rather than forget the waiting paths when the list cannot be read", async function () {
    fs.writeFileSync(unappliedFile(), '["a.txt", "b.t');

    const error = await run({ push: true });

    expect(error).toBeTruthy();
    expect(isRedisUnavailableError(error)).toBe(false);
    expect(released).toBe(1);
    expect(updates).toEqual([]);
    expect(fs.readFileSync(unappliedFile(), "utf-8")).toEqual('["a.txt", "b.t');
  });

  it("keeps going past other errors, and remembers nothing", async function () {
    spyOn(console, "log");
    failing["a.txt"] = new Error("this file is broken");

    expect(await run({ push: true })).toBe(null);
    expect(updates).toEqual(["a.txt", "b.txt"]);
    expect(fs.existsSync(unappliedFile())).toBe(false);
  });
});
