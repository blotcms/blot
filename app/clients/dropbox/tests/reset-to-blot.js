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
  let revisionCalls;

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

  // delta: entries Dropbox reports since the pre-walk cursor, i.e. edits
  // made during the walk. Omit it to make that call fail. revisions: what
  // list_revisions says for each Dropbox path, a result or an Error to throw;
  // omit it for a client with no such method at all. revisionCalls records
  // the paths it was asked about.
  function load(remote, { delta, account = {}, revisions } = {}) {
    revisionCalls = [];
    require.cache[createClientPath] = {
      exports: function (_blogID, callback) {
        callback(null, {
          filesGetMetadata: async () => ({
            result: { path_display: "/Blog Folder" },
          }),
          ...(revisions && {
            filesListRevisions: async ({ path, mode, limit }) => {
              revisionCalls.push({ path, mode, limit });
              const result = revisions[path];
              if (!result || result instanceof Error)
                throw result || new Error("path/not_found");
              return { result };
            },
          }),
          filesListFolderGetLatestCursor: async () => ({
            result: { cursor: "new-cursor" },
          }),
          filesListFolder: async ({ path }) => {
            // The walk asks for the blog folder root as "/Blog Folder/"
            const entries = remote[(path || "/").replace(/(.)\/$/, "$1")];
            if (!entries) throw new Error("Dropbox unavailable");
            return { result: { entries, has_more: false, cursor: "c" } };
          },
          filesListFolderContinue: async ({ cursor }) => {
            if (cursor !== "new-cursor" || !delta)
              throw new Error("Dropbox unavailable");
            return {
              result: { entries: delta, has_more: false, cursor: "later" },
            };
          },
        }, account);
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

  it("counts a file it could not download, and carries on with the rest", async function () {
    load({ "/": [file("a.txt"), file("b.txt")] });
    require.cache[downloadPath].exports = function (_client, source, destination, callback) {
      if (source === "/a.txt") return callback(new Error("download exploded"));
      fs.outputFile(destination, "hello").then(() => callback(null), callback);
    };
    // reset-to-blot promisified the download stub when it loaded
    delete require.cache[resetPath];
    const resetToBlot = require("../sync/reset-to-blot");

    const summary = await resetToBlot(blogID, () => {}, async () => {});

    expect(summary.downloaded).toEqual(1);
    expect(summary.failed).toEqual(1);
    expect(summary.firstError).toEqual("/a.txt: download exploded");
  });

  it("updates every path inside a folder it removes", async function () {
    await fs.outputFile(join(blogDirectory, "Sub", "a.txt"), "x");
    await fs.outputFile(join(blogDirectory, "Sub", "Inner", "b.txt"), "x");
    const resetToBlot = load({ "/": [] }, { delta: [] });
    const update = jasmine.createSpy("update").and.returnValue(Promise.resolve());

    await resetToBlot(blogID, () => {}, update);

    const updated = update.calls.allArgs().map(([path]) => path);
    expect(updated.sort()).toEqual(
      ["/Sub", "/Sub/a.txt", "/Sub/Inner", "/Sub/Inner/b.txt"].sort()
    );
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

  describe("changes made in Dropbox during the walk", function () {
    const countChanges = require("clients/util/countChanges");
    const deleted = (path_lower) => ({ ".tag": "deleted", path_lower });

    it("excuses a removal Dropbox reports since the pre-walk cursor", async function () {
      await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
      const resetToBlot = load({ "/": [] }, { delta: [deleted("/gone.txt")] });

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.removed).toEqual(1);
      expect(summary.changedDuringWalk).toEqual(1);
      expect(countChanges(summary)).toEqual(0);
    });

    it("excuses files removed along with a folder deleted mid-walk", async function () {
      await fs.outputFile(join(blogDirectory, "Sub", "a.log"), "x");
      await fs.outputFile(join(blogDirectory, "Sub", "b.log"), "x");
      const resetToBlot = load(
        {
          "/Blog Folder": [
            { ".tag": "folder", name: "Sub", path_display: "/Blog Folder/Sub" },
          ],
          "/Blog Folder/Sub": [],
        },
        {
          account: { folder_id: "id:folder" },
          delta: [
            deleted("/blog folder/sub/a.log"),
            deleted("/blog folder/sub/b.log"),
          ],
        }
      );

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.removed).toEqual(2);
      expect(countChanges(summary)).toEqual(0);
    });

    it("still counts removals Dropbox doesn't report as recent", async function () {
      await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
      await fs.outputFile(join(blogDirectory, "missed.txt"), "x");
      const resetToBlot = load({ "/": [] }, { delta: [deleted("/gone.txt")] });

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.removed).toEqual(2);
      expect(countChanges(summary)).toEqual(1);
    });

    describe("when Dropbox can't list what changed since the cursor", function () {
      const now = () => new Date().toISOString();
      const deletedAt = (server_deleted) => ({ is_deleted: true, server_deleted });
      const longAgo = "2026-01-01T00:00:00Z";

      it("excuses a file removed just before the walk, by its deletion time", async function () {
        await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          { revisions: { "/gone.txt": deletedAt(now()) } }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.removed).toEqual(1);
        expect(summary.changedDuringWalk).toEqual(1);
        expect(countChanges(summary)).toEqual(0);
        expect(revisionCalls).toEqual([
          { path: "/gone.txt", mode: "path", limit: 1 },
        ]);
      });

      it("looks the file up under the blog folder in Dropbox", async function () {
        await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
        const resetToBlot = load(
          { "/Blog Folder": [] },
          {
            account: { folder_id: "id:folder" },
            revisions: { "/Blog Folder/gone.txt": deletedAt(now()) },
          }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(countChanges(summary)).toEqual(0);
      });

      it("counts a file deleted long ago", async function () {
        await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          { revisions: { "/gone.txt": deletedAt(longAgo) } }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.changedDuringWalk).toEqual(0);
        expect(countChanges(summary)).toEqual(1);
      });

      it("counts a file Dropbox doesn't say was deleted, or doesn't date", async function () {
        await fs.outputFile(join(blogDirectory, "a.txt"), "x");
        await fs.outputFile(join(blogDirectory, "b.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          {
            revisions: {
              "/a.txt": { is_deleted: false, server_deleted: now() },
              "/b.txt": { is_deleted: true },
            },
          }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.removed).toEqual(2);
        expect(countChanges(summary)).toEqual(2);
      });

      it("excuses a removed folder by when a file in it was deleted", async function () {
        await fs.outputFile(join(blogDirectory, "Sub", "Inner", "b.txt"), "x");
        await fs.outputFile(join(blogDirectory, "Sub", "a.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          { revisions: { "/Sub/a.txt": deletedAt(now()) } }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.removed).toEqual(1);
        expect(summary.changedDuringWalk).toEqual(1);
        expect(countChanges(summary)).toEqual(0);
        // Files only: list_revisions doesn't work on folders. It stops at the
        // first file with a recent deletion, whichever readdir lists first.
        expect(revisionCalls.length).toBeGreaterThan(0);
        revisionCalls.forEach(({ path }) => expect(path).toMatch(/\.txt$/));
      });

      it("asks about only a few files of a removed folder", async function () {
        for (const name of ["a", "b", "c", "d", "e"])
          await fs.outputFile(join(blogDirectory, "Sub", name + ".txt"), "x");
        const resetToBlot = load({ "/": [] }, { revisions: {} });

        const summary = await resetToBlot(blogID, () => {});

        expect(revisionCalls.length).toEqual(3);
        expect(countChanges(summary)).toEqual(1);
      });

      it("counts a removed empty folder, which has nothing to date it", async function () {
        await fs.ensureDir(join(blogDirectory, "Empty"));
        const resetToBlot = load({ "/": [] }, { revisions: {} });

        const summary = await resetToBlot(blogID, () => {});

        expect(revisionCalls).toEqual([]);
        expect(countChanges(summary)).toEqual(1);
      });

      it("excuses a created folder when a file downloaded into it was modified recently", async function () {
        const resetToBlot = load({
          "/": [{ ".tag": "folder", name: "Sub", path_display: "/Sub" }],
          "/Sub": [
            {
              ".tag": "file",
              name: "a.txt",
              path_display: "/Sub/a.txt",
              content_hash: "hash",
              size: 5,
              server_modified: now(),
            },
          ],
        });

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.createdDirs).toEqual(1);
        expect(summary.modifiedDuringWalk).toEqual(1);
        expect(summary.changedDuringWalk).toEqual(1);
        expect(countChanges(summary)).toEqual(0);
      });

      it("counts a created folder whose files were modified long ago", async function () {
        const resetToBlot = load({
          "/": [{ ".tag": "folder", name: "Sub", path_display: "/Sub" }],
          "/Sub": [{ ...file("a.txt"), path_display: "/Sub/a.txt" }],
        });

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.createdDirs).toEqual(1);
        expect(countChanges(summary)).toEqual(2);
      });

      it("counts the change if list_revisions fails, and persists no error", async function () {
        await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          { revisions: { "/gone.txt": new Error("too_many_requests") } }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.changedDuringWalk).toEqual(0);
        expect(countChanges(summary)).toEqual(1);
        expect(saved.some((values) => values.error_code)).toEqual(false);
      });

      it("doesn't count a change twice if the cursor already excused it", async function () {
        await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
        const resetToBlot = load(
          { "/": [] },
          {
            delta: [deleted("/gone.txt")],
            revisions: { "/gone.txt": deletedAt(now()) },
          }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.changedDuringWalk).toEqual(1);
        expect(revisionCalls).toEqual([]);
      });
    });

    it("counts every change if Dropbox can't list what changed", async function () {
      await fs.outputFile(join(blogDirectory, "gone.txt"), "x");
      const resetToBlot = load({ "/": [] });

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.changedDuringWalk).toEqual(0);
      expect(countChanges(summary)).toEqual(1);
    });
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
