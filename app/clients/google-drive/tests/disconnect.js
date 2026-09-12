const fs = require("fs");
const vm = require("vm");

function load(stubs) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../disconnect"), "utf8"), {
    module,
    exports: module.exports,
    require: name => Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : require(name),
  });
  return module.exports;
}

describe("Drive disconnect", function() {
  it("resets the folder's verified-content cache and cursor, scoped to the blog", async function() {
    let resetArgs = null;
    const disconnect = load({
      "models/blog": {
        set(blogID, data, callback) { callback(); },
      },
      "./database": {
        blog: {
          get: async () => ({ folderId: "folder-1", serviceAccountId: "account" }),
          delete: async () => {},
        },
        folder: (folderId, blogID) => ({
          reset: async (options) => {
            resetArgs = { folderId, blogID, options };
          },
        }),
      },
    });

    await new Promise(resolve => disconnect("blog-1", resolve));

    expect(resetArgs).toEqual({ folderId: "folder-1", blogID: "blog-1", options: undefined });
  });

  it("does not try to reset a folder when the blog had none", async function() {
    let folderCalled = false;
    const disconnect = load({
      "models/blog": {
        set(blogID, data, callback) { callback(); },
      },
      "./database": {
        blog: {
          get: async () => null,
          delete: async () => {},
        },
        folder: () => {
          folderCalled = true;
          return { reset: async () => {} };
        },
      },
    });

    await new Promise(resolve => disconnect("blog-1", resolve));

    expect(folderCalled).toBe(false);
  });
});
