const fs = require("fs");
const vm = require("vm");

function load(file, stubs) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), "utf8"), {
    module,
    exports: module.exports,
    require: (name) =>
      Object.prototype.hasOwnProperty.call(stubs, name)
        ? stubs[name]
        : require(name),
  });
  return module.exports;
}

// database stubbed with the accounts given ({ blogID: account }), recording
// what is deleted and reset
function fakeDatabase(accounts) {
  const calls = { deleted: [], dirtyForgotten: [], reset: [] };
  const database = {
    blog: {
      get: async (blogID) => accounts[blogID] || null,
      delete: async (blogID) => {
        calls.deleted.push(blogID);
        delete accounts[blogID];
      },
      iterate: async (callback) => {
        for (const [blogID, account] of Object.entries(accounts))
          await callback(blogID, account);
      },
    },
    dirty: {
      forget: async (blogID) => calls.dirtyForgotten.push(blogID),
    },
    folder: (folderId, blogID) => ({
      reset: async (options) => calls.reset.push({ folderId, blogID, options }),
    }),
  };
  return { database, calls };
}

const loadForget = (database) => load("../forget", { "./database": database });

describe("Drive disconnect", function () {
  it("forgets the blog's records, removes its placeholders and clears its client", async function () {
    const { database, calls } = fakeDatabase({
      "blog-1": { folderId: "folder-1", serviceAccountId: "account" },
    });
    const removed = [];
    const set = [];
    const disconnect = load("../disconnect", {
      "./forget": loadForget(database),
      "clients/util/placeholders": {
        removeAtDisconnect: async (blogID) => removed.push(blogID),
      },
      "models/blog": { set: async (blogID, data) => set.push([blogID, data]) },
    });

    await disconnect("blog-1");

    expect(calls.deleted).toEqual(["blog-1"]);
    expect(calls.reset).toEqual([
      { folderId: "folder-1", blogID: "blog-1", options: undefined },
    ]);
    expect(removed).toEqual(["blog-1"]);
    expect(set).toEqual([["blog-1", { client: "" }]]);
  });
});

describe("Drive forget", function () {
  it("deletes the account, its dirty directories and its folder's mapping", async function () {
    const { database, calls } = fakeDatabase({
      "blog-1": { folderId: "folder-1", serviceAccountId: "account" },
    });

    await loadForget(database)("blog-1");

    expect(calls.deleted).toEqual(["blog-1"]);
    expect(calls.dirtyForgotten).toEqual(["blog-1"]);
    expect(calls.reset).toEqual([
      { folderId: "folder-1", blogID: "blog-1", options: undefined },
    ]);
  });

  it("keeps a folder's mapping another blog's account still names", async function () {
    const { database, calls } = fakeDatabase({
      "blog-1": { folderId: "folder-1" },
      "blog-2": { folderId: "folder-1" },
    });

    await loadForget(database)("blog-1");

    expect(calls.deleted).toEqual(["blog-1"]);
    expect(calls.reset).toEqual([]);
  });

  it("does nothing more for a blog with no Drive account", async function () {
    const { database, calls } = fakeDatabase({});

    await loadForget(database)("blog-1");

    expect(calls.deleted).toEqual(["blog-1"]);
    expect(calls.dirtyForgotten).toEqual(["blog-1"]);
    expect(calls.reset).toEqual([]);
  });
});
