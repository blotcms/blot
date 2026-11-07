describe("dropbox resetToBlot", function () {
  const storage = require("storage/folder");

  const resetPath = require.resolve("../sync/reset-to-blot");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const downloadPath = require.resolve("../util/download");

  const blogID = "blog_resettoblottest" + Date.now();
  const originals = {};
  let saved;
  let revisionCalls;

  beforeEach(async function () {
    saved = [];
    [resetPath, createClientPath, databasePath, downloadPath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
  });

  afterEach(async function () {
    delete require.cache[resetPath];
    [createClientPath, databasePath, downloadPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    if (originals[resetPath]) require.cache[resetPath] = originals[resetPath];
    await storage.removeAll(blogID);
  });

  // delta: entries Dropbox reports since the pre-walk cursor, i.e. edits
  // made during the walk. Omit it to make that call fail. revisions: what
  // list_revisions says for each Dropbox path, a result or an Error to throw;
  // omit it for a client with no such method at all. revisionCalls records
  // the paths it was asked about.
  function load(remote, { delta, account = {}, revisions } = {}) {
    revisionCalls = [];
    require.cache[createClientPath] = {
      exports: async function () {
        return {
          error: null,
          client: {
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
          },
          account,
        };
      },
    };
    require.cache[databasePath] = {
      exports: {
        set: async function (_blogID, values) {
          saved.push(values);
        },
      },
    };
    require.cache[downloadPath] = {
      exports: function (_client, source, id, destination) {
        return storage.write(id, destination, "hello");
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
    const update = jasmine
      .createSpy("update")
      .and.returnValue(Promise.resolve());

    const summary = await resetToBlot(blogID, () => {}, update);

    expect(summary.downloaded).toEqual(1);
    expect(update).toHaveBeenCalledWith("/a.txt");
    expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
      true
    );
  });

  describe("comparing a file with Dropbox's", function () {
    // Dropbox's content_hash of a file under 4MB: sha256 of its sha256
    const sha256 = (input) =>
      require("crypto").createHash("sha256").update(input).digest();
    const helloHash = sha256(sha256("hello")).toString("hex");

    const hashedStats = () =>
      storage.stat.calls
        .allArgs()
        .filter(([, , options]) => options && options.hash);

    beforeEach(function () {
      spyOn(storage, "stat").and.callThrough();
    });

    it("downloads a file of another size without hashing it", async function () {
      await storage.write(blogID, "/a.txt", "hello world");
      const resetToBlot = load({
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      });

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(hashedStats()).toEqual([]);
    });

    it("hashes a file of the same size, and skips it when the hashes match", async function () {
      await storage.write(blogID, "/a.txt", "hello");
      const resetToBlot = load({
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      });

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(0);
      expect(hashedStats().length).toEqual(1);
    });

    it("downloads a file of the same size when the hashes differ", async function () {
      await storage.write(blogID, "/a.txt", "world");
      const resetToBlot = load({
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      });

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(hashedStats().length).toEqual(1);
    });

    it("downloads a file that is not in the folder", async function () {
      const resetToBlot = load({
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      });

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(hashedStats()).toEqual([]);
    });
  });

  it("counts a file it could not download, and carries on with the rest", async function () {
    load({ "/": [file("a.txt"), file("b.txt")] });
    require.cache[downloadPath].exports = async function (
      _client,
      source,
      id,
      destination
    ) {
      if (source === "/a.txt") throw new Error("download exploded");
      await storage.write(id, destination, "hello");
    };
    // reset-to-blot took the download stub when it loaded
    delete require.cache[resetPath];
    const resetToBlot = require("../sync/reset-to-blot");

    const summary = await resetToBlot(
      blogID,
      () => {},
      async () => {}
    );

    expect(summary.downloaded).toEqual(1);
    expect(summary.failed).toEqual(1);
    expect(summary.firstError).toEqual("/a.txt: download exploded");
  });

  describe("a file over the download size limit", function () {
    const constants = require("../util/constants");
    let maxFileSize;

    // A limit below the fixtures' sizes, so a matching local copy can have
    // the same size as the Dropbox file. reset-to-blot reads it when it loads.
    beforeEach(function () {
      maxFileSize = constants.MAX_FILE_SIZE;
      constants.MAX_FILE_SIZE = 4;
    });

    afterEach(function () {
      constants.MAX_FILE_SIZE = maxFileSize;
    });

    const oversized = (content_hash, size) => ({
      ".tag": "file",
      name: "big.txt",
      path_display: "/big.txt",
      content_hash,
      size,
      server_modified: "2026-01-01T00:00:00Z",
    });

    it("keeps a local copy whose content hash matches (a file Blot uploaded)", async function () {
      await storage.write(blogID, "/big.txt", "real contents");
      const { hash, size } = await storage.stat(blogID, "/big.txt", {
        hash: true,
      });
      const resetToBlot = load({ "/": [oversized(hash, size)] });

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.skipped).toEqual(1);
      expect((await storage.read(blogID, "/big.txt")).toString()).toEqual(
        "real contents"
      );
    });

    it("replaces a local copy that differs, or is absent, with an empty placeholder", async function () {
      await storage.write(blogID, "/big.txt", "something else");
      let resetToBlot = load({ "/": [oversized("not-the-local-hash", 14)] });
      await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );
      expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");

      await storage.remove(blogID, "/big.txt");
      resetToBlot = load({ "/": [oversized("not-the-local-hash", 14)] });
      await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );
      expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");
    });
  });

  it("updates every path inside a folder it removes", async function () {
    await storage.write(blogID, "/Sub/a.txt", "x");
    await storage.write(blogID, "/Sub/Inner/b.txt", "x");
    const resetToBlot = load({ "/": [] }, { delta: [] });
    const update = jasmine
      .createSpy("update")
      .and.returnValue(Promise.resolve());

    await resetToBlot(blogID, () => {}, update);

    const updated = update.calls.allArgs().map(([path]) => path);
    expect(updated.sort()).toEqual(
      ["/Sub", "/Sub/a.txt", "/Sub/Inner", "/Sub/Inner/b.txt"].sort()
    );
  });

  it("keeps updates and the old cursor when the walk throws part way", async function () {
    const resetToBlot = load({
      "/": [
        file("a.txt"),
        { ".tag": "folder", name: "sub", path_display: "/sub" },
      ],
    });
    const update = jasmine
      .createSpy("update")
      .and.returnValue(Promise.resolve());

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

  describe("a folder that changes in Dropbox before the walk lists it", function () {
    const folder = (name) => ({
      ".tag": "folder",
      name,
      path_display: "/" + name,
    });

    // Make filesListFolder answer `path` with a 409 tagged `summary`, as
    // Dropbox does for a folder deleted after its parent was listed
    function vanish(path, summary) {
      const inner = require.cache[createClientPath].exports;
      require.cache[createClientPath].exports = async function (id) {
        const result = await inner(id);
        const client = result.client;
        const real = client.filesListFolder;
        client.filesListFolder = async (args) => {
          if (args.path === path)
            throw Object.assign(new Error("Response failed with a 409 code"), {
              status: 409,
              error: { error_summary: summary },
            });
          return real(args);
        };
        return result;
      };
      delete require.cache[resetPath];
      return require("../sync/reset-to-blot");
    }

    const deleted = (path_lower) => ({ ".tag": "deleted", path_lower });

    it("skips the folder, leaves Blot's copy alone and finishes the walk", async function () {
      await storage.write(blogID, "/sub/old.txt", "x");
      load(
        { "/": [folder("sub"), file("a.txt")] },
        { delta: [deleted("/sub")] }
      );
      const resetToBlot = vanish("/sub", "path/not_found/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(summary.removed).toEqual(0);
      expect(summary.skipped).toEqual(1);
      expect(summary.failed).toEqual(0);
      expect(await storage.exists(blogID, "/sub/old.txt")).toEqual(true);
      expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
        true
      );
    });

    it("skips a folder Dropbox reports as changed under it", async function () {
      load({ "/": [folder("sub")] }, { delta: [deleted("/sub/old.txt")] });
      const resetToBlot = vanish("/sub", "path/not_found/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.skipped).toEqual(1);
      expect(summary.failed).toEqual(0);
    });

    it("reports a 409 the cursor doesn't explain, and removes nothing", async function () {
      await storage.write(blogID, "/sub/old.txt", "x");
      load(
        { "/": [folder("sub"), file("a.txt")] },
        { delta: [deleted("/other")] }
      );
      const resetToBlot = vanish("/sub", "path/not_found/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(summary.skipped).toEqual(0);
      expect(summary.failed).toEqual(1);
      expect(summary.firstError).toEqual("/sub: 409 path/not_found/..");
      expect(await storage.exists(blogID, "/sub/old.txt")).toEqual(true);
    });

    it("reports the 409 when Dropbox can't say what changed", async function () {
      load({ "/": [folder("sub")] });
      const resetToBlot = vanish("/sub", "path/not_found/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.failed).toEqual(1);
    });

    it("skips a folder replaced by a file", async function () {
      load(
        { "/": [folder("sub")] },
        { delta: [{ ".tag": "file", path_lower: "/sub" }] }
      );
      const resetToBlot = vanish("/sub", "path/not_folder/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.skipped).toEqual(1);
    });

    it("still throws when the blog folder itself is gone", async function () {
      load({ "/": [file("a.txt")] });
      const resetToBlot = vanish("", "path/not_found/..");

      let error;
      try {
        await resetToBlot(
          blogID,
          () => {},
          async () => {}
        );
      } catch (err) {
        error = err;
      }

      expect(error && error.status).toEqual(409);
      expect(saved.some((values) => "cursor" in values)).toEqual(false);
    });

    it("still throws on any other 409", async function () {
      load({ "/": [folder("sub")] });
      const resetToBlot = vanish("/sub", "path/restricted_content/..");

      let error;
      try {
        await resetToBlot(
          blogID,
          () => {},
          async () => {}
        );
      } catch (err) {
        error = err;
      }

      expect(error && error.status).toEqual(409);
    });
  });

  describe("transient Dropbox errors", function () {
    const retryRequest = require("../util/retryRequest");
    const originalDelays = retryRequest.delays;

    beforeEach(function () {
      retryRequest.delays = [1, 1];
    });

    afterEach(function () {
      retryRequest.delays = originalDelays;
    });

    // Make filesListFolder fail with a 500 `failures` times before working
    function failListFolder(failures) {
      const inner = require.cache[createClientPath].exports;
      const state = { calls: 0 };
      require.cache[createClientPath].exports = async function (id) {
        const result = await inner(id);
        const client = result.client;
        const real = client.filesListFolder;
        client.filesListFolder = async (args) => {
          if (++state.calls <= failures)
            throw Object.assign(new Error("Response failed with a 500 code"), {
              status: 500,
            });
          return real(args);
        };
        return result;
      };
      delete require.cache[resetPath];
      state.resetToBlot = require("../sync/reset-to-blot");
      return state;
    }

    it("does not abort the walk when list_folder 500s once", async function () {
      load({ "/": [file("a.txt")] });
      const state = failListFolder(1);

      const summary = await state.resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(state.calls).toEqual(2);
      expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
        true
      );
    });

    it("still throws when list_folder keeps returning 500", async function () {
      load({ "/": [file("a.txt")] });
      const state = failListFolder(Infinity);

      let error;
      try {
        await state.resetToBlot(
          blogID,
          () => {},
          async () => {}
        );
      } catch (err) {
        error = err;
      }

      expect(error.status).toEqual(500);
      expect(state.calls).toEqual(3);
      expect(saved.some((values) => "cursor" in values)).toEqual(false);
    });
  });

  describe("changes made in Dropbox during the walk", function () {
    const countChanges = require("clients/util/countChanges");
    const deleted = (path_lower) => ({ ".tag": "deleted", path_lower });

    it("excuses a removal Dropbox reports since the pre-walk cursor", async function () {
      await storage.write(blogID, "/gone.txt", "x");
      const resetToBlot = load({ "/": [] }, { delta: [deleted("/gone.txt")] });

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.removed).toEqual(1);
      expect(summary.changedDuringWalk).toEqual(1);
      expect(countChanges(summary)).toEqual(0);
    });

    it("excuses files removed along with a folder deleted mid-walk", async function () {
      await storage.write(blogID, "/Sub/a.log", "x");
      await storage.write(blogID, "/Sub/b.log", "x");
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
      await storage.write(blogID, "/gone.txt", "x");
      await storage.write(blogID, "/missed.txt", "x");
      const resetToBlot = load({ "/": [] }, { delta: [deleted("/gone.txt")] });

      const summary = await resetToBlot(blogID, () => {});

      expect(summary.removed).toEqual(2);
      expect(countChanges(summary)).toEqual(1);
    });

    describe("when Dropbox can't list what changed since the cursor", function () {
      const now = () => new Date().toISOString();
      const deletedAt = (server_deleted) => ({
        is_deleted: true,
        server_deleted,
      });
      const longAgo = "2026-01-01T00:00:00Z";

      it("excuses a file removed just before the walk, by its deletion time", async function () {
        await storage.write(blogID, "/gone.txt", "x");
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
        await storage.write(blogID, "/gone.txt", "x");
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
        await storage.write(blogID, "/gone.txt", "x");
        const resetToBlot = load(
          { "/": [] },
          { revisions: { "/gone.txt": deletedAt(longAgo) } }
        );

        const summary = await resetToBlot(blogID, () => {});

        expect(summary.changedDuringWalk).toEqual(0);
        expect(countChanges(summary)).toEqual(1);
      });

      it("counts a file Dropbox doesn't say was deleted, or doesn't date", async function () {
        await storage.write(blogID, "/a.txt", "x");
        await storage.write(blogID, "/b.txt", "x");
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
        await storage.write(blogID, "/Sub/Inner/b.txt", "x");
        await storage.write(blogID, "/Sub/a.txt", "x");
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
          await storage.write(blogID, "/Sub/" + name + ".txt", "x");
        const resetToBlot = load({ "/": [] }, { revisions: {} });

        const summary = await resetToBlot(blogID, () => {});

        expect(revisionCalls.length).toEqual(3);
        expect(countChanges(summary)).toEqual(1);
      });

      it("counts a removed empty folder, which has nothing to date it", async function () {
        await storage.mkdir(blogID, "/Empty");
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
        await storage.write(blogID, "/gone.txt", "x");
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
        await storage.write(blogID, "/gone.txt", "x");
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
      await storage.write(blogID, "/gone.txt", "x");
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
        exports: async function () {
          const explode = () => {
            throw new Error("should not be called - the guard must run first");
          };
          return {
            error: null,
            client: {
              filesGetMetadata: explode,
              filesListFolderGetLatestCursor: explode,
              filesListFolder: explode,
            },
            account,
          };
        },
      };
      require.cache[databasePath] = {
        exports: {
          set: async function (_blogID, values) {
            saved.push(values);
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
        await resetToBlot(
          blogID,
          () => {},
          () => {}
        );
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
        await resetToBlot(
          blogID,
          () => {},
          () => {}
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(error.code).toEqual("DROPBOX_TRANSFER_INCOMPLETE");
      expect(saved.length).toEqual(0);
    });
  });
});
