describe("dropbox resetToBlot", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const { blog_folder_dir } = require("config");

  const resetPath = require.resolve("../sync/reset-to-blot");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const downloadPath = require.resolve("../util/download");

  const blogID = "blog_resettoblottest" + Date.now();
  const blogDirectory = join(blog_folder_dir, blogID);
  const originals = {};
  let saved;

  beforeEach(async function () {
    saved = [];
    [resetPath, createClientPath, databasePath, downloadPath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
    await fs.ensureDir(blogDirectory);
  });

  afterEach(async function () {
    delete require.cache[resetPath];
    [createClientPath, databasePath, downloadPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    if (originals[resetPath]) require.cache[resetPath] = originals[resetPath];
    await fs.remove(blogDirectory);
  });

  function load(remote) {
    require.cache[createClientPath] = {
      exports: function (_blogID, callback) {
        callback(null, {
          filesListFolderGetLatestCursor: async () => ({
            result: { cursor: "new-cursor" },
          }),
          filesListFolder: async ({ path }) => {
            const entries = remote[path || "/"];
            if (!entries) throw new Error("Dropbox unavailable");
            return { result: { entries, has_more: false, cursor: "c" } };
          },
        }, {});
      },
    };
    require.cache[databasePath] = {
      exports: {
        set: function (_blogID, values, callback) {
          saved.push(values);
          callback(null);
        },
      },
    };
    require.cache[downloadPath] = {
      exports: function (_client, source, destination, callback) {
        fs.outputFile(destination, "hello").then(() => callback(null), callback);
      },
    };
    delete require.cache[resetPath];
    return require("../sync/reset-to-blot");
  }

  const file = (name) => ({
    ".tag": "file",
    name,
    path_display: "/" + name,
    content_hash: "hash",
    size: 5,
    server_modified: "2026-01-01T00:00:00Z",
  });

  it("updates each path as it downloads and saves the cursor at the end", async function () {
    const resetToBlot = load({ "/": [file("a.txt")] });
    const update = jasmine.createSpy("update").and.returnValue(Promise.resolve());

    const summary = await resetToBlot(blogID, () => {}, update);

    expect(summary.downloaded).toEqual(1);
    expect(update).toHaveBeenCalledWith("/a.txt");
    expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(true);
  });

  it("keeps updates and the old cursor when the walk throws part way", async function () {
    const resetToBlot = load({
      "/": [file("a.txt"), { ".tag": "folder", name: "sub", path_display: "/sub" }],
    });
    const update = jasmine.createSpy("update").and.returnValue(Promise.resolve());

    let error;
    try {
      await resetToBlot(blogID, () => {}, update);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(update).toHaveBeenCalledWith("/a.txt");
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  // resetToBlot treats Dropbox as the source of truth and deletes any local
  // file with no Dropbox counterpart, so it must refuse outright - before
  // touching anything - for a blog whose initial transfer to Dropbox hasn't
  // finished (transfer_pending, or the legacy error_code: 507). This is the
  // one guard every caller (init.js's resetToBlotWithLock, the manual
  // "Resync from Dropbox" dashboard action, scripts/dropbox/*.js) relies on.
  describe("refuses when the account's initial transfer hasn't finished", function () {
    function loadWithAccount(account) {
      require.cache[createClientPath] = {
        exports: function (_blogID, callback) {
          const explode = () => {
            throw new Error("should not be called - the guard must run first");
          };
          callback(
            null,
            {
              filesGetMetadata: explode,
              filesListFolderGetLatestCursor: explode,
              filesListFolder: explode,
            },
            account
          );
        },
      };
      require.cache[databasePath] = {
        exports: {
          set: function (_blogID, values, callback) {
            saved.push(values);
            callback(null);
          },
        },
      };
      delete require.cache[resetPath];
      return require("../sync/reset-to-blot");
    }

    it("refuses for transfer_pending", async function () {
      const resetToBlot = loadWithAccount({
        transfer_pending: true,
        error_code: 0,
        folder_id: "",
      });

      let error;
      try {
        await resetToBlot(blogID, () => {}, () => {});
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error.code).toEqual("DROPBOX_TRANSFER_INCOMPLETE");
      expect(saved.length).toEqual(0);
    });

    it("refuses for the legacy out-of-space error code", async function () {
      const resetToBlot = loadWithAccount({
        transfer_pending: false,
        error_code: 507,
        folder_id: "",
      });

      let error;
      try {
        await resetToBlot(blogID, () => {}, () => {});
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error.code).toEqual("DROPBOX_TRANSFER_INCOMPLETE");
      expect(saved.length).toEqual(0);
    });
  });
});
