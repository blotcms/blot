const fs = require("fs");
const vm = require("vm");
const validateTree = require("../validateTree");

describe("Git sync tree policy", function () {
  async function run(tree) {
    const resets = [];
    let released = false;
    const git = {
      silent() { return this; },
      remote(args, cb) { cb(null); },
      fetch(args, cb) { cb(null); },
      raw(args, cb) {
        let value = "previous";
        if (args[0] === "rev-parse" && args.includes("--verify")) value = "validated";
        if (args[0] === "ls-tree") value = tree;
        if (args[0] === "reset") resets.push(args[3]);
        if (cb) return cb(null, value);
        return Promise.resolve(value);
      },
    };
    const stubs = {
      async: {}, debug:()=>()=>{}, "./git":()=>git,
      sync: (id, cb) => cb(null, {path:"/test-blog",log(){}}, (err, cb) => {released = true; cb(err);}),
      "./checkGitRepoExists":(path, cb)=>cb(null), "./repo":{directory:handle=>"/test-data/"+handle+".git",followLiveClone:(git, handle, commit, cb)=>git.raw(["reset","--mixed","--quiet",commit], cb)},
      "./materialize":Object.assign((directory, folder, base, commit, cb)=>cb(null, []), {EMPTY_TREE:"empty"}),
      "models/blog":{}, "./validateTree":validateTree,
      "./database":{getApplied:(id, cb)=>cb(null, null), setApplied:(id, commit, cb)=>cb(null)},
    };
    const module = {exports:{}};
    vm.runInNewContext(fs.readFileSync(require.resolve("../sync"), "utf8"), {
      module, exports:module.exports, console,
      require:name => name in stubs ? stubs[name] : require(name),
    });
    const error = await new Promise(resolve => module.exports("test", "test", resolve));
    return {error, released, resets};
  }
  it("leaves the checkout untouched and releases its lock on rejection", async function () {
    const result = await run("120000 blob abc\tlink.txt\0");
    expect(result.error.message).toContain("regular files only");
    expect(result.resets).toEqual([]);
    expect(result.released).toBe(true);
  });
  it("moves the live clone to the validated commit ID instead of the mutable branch", async function () {
    const result = await run("100644 blob abc\tfile.txt\0");
    expect(result.error).toBe(null);
    expect(result.resets).toEqual(["validated"]);
    expect(result.released).toBe(true);
  });
});
