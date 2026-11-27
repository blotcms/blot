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
  // Every filesListFolder and filesListFolderContinue call of the walk
  // (not the delta's), as { recursive, path } or { cursor }
  let listCalls;

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
    await require("../util/hashes").drop(blogID);
  });

  // delta: entries Dropbox reports since the pre-walk cursor, i.e. edits
  // made during the walk. Omit it to make that call fail. revisions: what
  // list_revisions says for each Dropbox path, a result or an Error to throw;
  // omit it for a client with no such method at all. revisionCalls records
  // the paths it was asked about.
  // pageSize: entries a recursive listing returns per page (default: all)
  function load(
    remote,
    { delta, account = {}, revisions, pageSize = Infinity } = {}
  ) {
    revisionCalls = [];
    listCalls = [];
    // What a recursive listing of the blog folder returns: every entry of
    // `remote`, with the path_lower Dropbox gives it
    const recursiveEntries = () =>
      Object.entries(remote).flatMap(([dir, entries]) =>
        entries.map((entry) => ({
          ...entry,
          path_lower: (
            (dir === "/" ? "" : dir) +
            "/" +
            entry.name
          ).toLowerCase(),
        }))
      );
    const page = (all, start) => ({
      result: {
        entries: all.slice(start, start + pageSize),
        has_more: start + pageSize < all.length,
        cursor: "page-" + (start + pageSize),
      },
    });
    require.cache[createClientPath] = {
      exports: async function () {
        return {
          error: null,
          client: {
            filesGetMetadata: async () => ({
              result: {
                path_display: "/Blog Folder",
                path_lower: "/blog folder",
              },
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
            filesListFolder: async ({ path, recursive }) => {
              listCalls.push({ recursive: Boolean(recursive), path });
              if (recursive) return page(recursiveEntries(), 0);
              // The walk asks for the blog folder root as "/Blog Folder/"
              const entries = remote[(path || "/").replace(/(.)\/$/, "$1")];
              if (!entries) throw new Error("Dropbox unavailable");
              return { result: { entries, has_more: false, cursor: "c" } };
            },
            filesListFolderContinue: async ({ cursor }) => {
              if (/^page-/.test(cursor)) {
                listCalls.push({ cursor });
                return page(recursiveEntries(), Number(cursor.slice(5)));
              }
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

  // Dropbox's 409 for a folder it won't list recursively
  const refuseRecursive = () =>
    Object.assign(new Error("Response failed with a 409 code"), {
      status: 409,
      error: { error_summary: "path/too_many_files/.." },
    });

  // Make the recursive listing fail as Dropbox would for a folder it won't
  // list recursively, so the walk lists each folder
  function refuseRecursiveListing() {
    const inner = require.cache[createClientPath].exports;
    require.cache[createClientPath].exports = async function (id) {
      const result = await inner(id);
      const real = result.client.filesListFolder;
      result.client.filesListFolder = async (args) => {
        if (args.recursive) {
          listCalls.push({ recursive: true, path: args.path });
          throw refuseRecursive();
        }
        return real(args);
      };
      return result;
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

  describe("listing the folder in Dropbox", function () {
    const folder = (name) => ({
      ".tag": "folder",
      name,
      path_display: "/" + name,
    });

    const tree = () => ({
      "/": [folder("sub"), folder("Empty"), file("a.txt")],
      "/sub": [folder("deep"), file("b.txt")],
      "/sub/deep": [file("c.txt")],
      "/Empty": [],
    });

    async function walkTree(resetToBlot) {
      const updated = [];
      const summary = await resetToBlot(
        blogID,
        () => {},
        async (path) => {
          updated.push(path);
        }
      );
      return { summary, updated: updated.sort() };
    }

    it("lists the whole tree once, in pages, instead of once per folder", async function () {
      const { summary, updated } = await walkTree(
        load(tree(), { pageSize: 2 })
      );

      // 6 entries, 2 to a page: the listing, then its two continuations. The
      // account has no folder_id, so the root is Dropbox's root, ""
      expect(listCalls).toEqual([
        { recursive: true, path: "" },
        { cursor: "page-2" },
        { cursor: "page-4" },
      ]);
      expect(summary.downloaded).toEqual(3);
      expect(summary.createdDirs).toEqual(3);
      expect(updated).toContain("/sub/deep/c.txt");
    });

    it("gives the same result as listing each folder", async function () {
      const recursive = await walkTree(load(tree()));
      await storage.removeAll(blogID);

      const perFolder = await walkTree(refuseRecursiveListing());

      // the recursive attempt, then root, sub, deep and Empty
      expect(listCalls.filter((call) => !call.recursive).length).toEqual(4);
      expect(perFolder.summary.downloaded).toEqual(
        recursive.summary.downloaded
      );
      expect(perFolder.summary.createdDirs).toEqual(
        recursive.summary.createdDirs
      );
      expect(perFolder.updated).toEqual(recursive.updated);
    });

    it("removes what the listing no longer has, in a folder and in an empty one", async function () {
      await storage.write(blogID, "/sub/gone.txt", "x");
      await storage.write(blogID, "/Empty/gone.txt", "x");

      const { summary } = await walkTree(load(tree()));

      expect(summary.removed).toEqual(2);
    });

    it("lists each folder when Dropbox refuses the recursive listing", async function () {
      load(tree());
      const messages = [];
      const summary = await refuseRecursiveListing()(
        blogID,
        (...args) => messages.push(args.join(" ")),
        async () => {}
      );

      expect(summary.downloaded).toEqual(3);
      expect(messages.some((m) => /listing each folder/.test(m))).toEqual(true);
    });
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

    it("hashes a file once, then answers from the stored hash", async function () {
      await storage.write(blogID, "/a.txt", "hello");
      const remote = {
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      };

      await load(remote)(
        blogID,
        () => {},
        async () => {}
      );
      expect(hashedStats().length).toEqual(1);

      storage.stat.calls.reset();
      const summary = await load(remote)(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(0);
      expect(hashedStats()).toEqual([]);
    });

    it("hashes again, and downloads, a file edited since its hash was stored", async function () {
      await storage.write(blogID, "/a.txt", "hello");
      const remote = {
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      };
      await load(remote)(
        blogID,
        () => {},
        async () => {}
      );

      // Edited in Blot to other bytes of the same size; Dropbox still has hello
      await storage.write(blogID, "/a.txt", "world");
      storage.stat.calls.reset();
      const summary = await load(remote)(
        blogID,
        () => {},
        async () => {}
      );

      expect(hashedStats().length).toEqual(1);
      expect(summary.downloaded).toEqual(1);
    });

    it("downloads without hashing when the stored hash disagrees with Dropbox's", async function () {
      await storage.write(blogID, "/a.txt", "hello");
      await load({
        "/": [{ ...file("a.txt"), content_hash: helloHash, size: 5 }],
      })(
        blogID,
        () => {},
        async () => {}
      );

      storage.stat.calls.reset();
      const worldHash = sha256(sha256("world")).toString("hex");
      const summary = await load({
        "/": [{ ...file("a.txt"), content_hash: worldHash, size: 5 }],
      })(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(hashedStats()).toEqual([]);
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

  it("records a file Dropbox refuses with a 409 and carries on with the rest", async function () {
    load({ "/": [file("a.txt"), file("b.txt")] });
    require.cache[downloadPath].exports = async function (
      _client,
      source,
      id,
      destination
    ) {
      if (source === "/a.txt")
        throw Object.assign(new Error("Response failed with a 409 code"), {
          status: 409,
          error: { error_summary: "path/restricted_content/.." },
        });
      await storage.write(id, destination, "hello");
    };
    delete require.cache[resetPath];
    const resetToBlot = require("../sync/reset-to-blot");

    const summary = await resetToBlot(
      blogID,
      () => {},
      async () => {}
    );

    expect(summary.downloaded).toEqual(1);
    expect(summary.failed).toEqual(1);
    expect(summary.firstError).toEqual(
      "/a.txt: Response failed with a 409 code"
    );
  });

  it("stops part way when the signal aborts, and leaves the cursor alone", async function () {
    const resetToBlot = load({ "/": [file("a.txt"), file("b.txt")] });
    const controller = new AbortController();
    const updated = [];

    let error;
    try {
      await resetToBlot(
        blogID,
        () => {},
        async (path) => {
          updated.push(path);
          controller.abort();
        },
        controller.signal
      );
    } catch (err) {
      error = err;
    }

    expect(error && error.name).toEqual("AbortError");
    expect(updated).toEqual(["/a.txt"]);
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
    expect(saved.some((values) => "error_code" in values)).toEqual(false);
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
      expect((await storage.stat(blogID, "/big.txt")).flags).toEqual([
        { code: "SYNC_TOO_LARGE", size: 14, limit: 4 },
      ]);

      await storage.remove(blogID, "/big.txt");
      resetToBlot = load({ "/": [oversized("not-the-local-hash", 14)] });
      await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );
      expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");
      expect((await storage.stat(blogID, "/big.txt")).flags).toEqual([
        { code: "SYNC_TOO_LARGE", size: 14, limit: 4 },
      ]);
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
    // Listed folder by folder, where the missing listing of /sub throws: a
    // recursive listing would read /sub as an empty folder
    load({
      "/": [
        file("a.txt"),
        { ".tag": "folder", name: "sub", path_display: "/sub" },
      ],
    });
    const resetToBlot = refuseRecursiveListing();
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
          // A recursive listing would not show a folder vanishing, so Dropbox
          // refuses it here and the walk lists each folder
          if (args.recursive) throw refuseRecursive();
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

    it("records any other 409 for a subfolder as a failed path and carries on", async function () {
      await storage.write(blogID, "/sub/old.txt", "x");
      load({ "/": [folder("sub"), file("a.txt")] });
      const resetToBlot = vanish("/sub", "path/restricted_content/..");

      const summary = await resetToBlot(
        blogID,
        () => {},
        async () => {}
      );

      expect(summary.downloaded).toEqual(1);
      expect(summary.removed).toEqual(0);
      expect(summary.failed).toEqual(1);
      expect(summary.firstError).toContain("/sub");
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

  describe("createReaddir", function () {
    const folder = (path) => ({
      ".tag": "folder",
      name: path.split("/").pop(),
      path_lower: path.toLowerCase(),
      path_display: path,
    });
    const file = (path) => ({
      ".tag": "file",
      name: path.split("/").pop(),
      path_lower: path.toLowerCase(),
      path_display: path,
    });

    function client(entries, perFolder) {
      return {
        perFolderCalls: [],
        filesListFolder: async function (args) {
          if (args.recursive)
            return { result: { entries, has_more: false, cursor: "c" } };
          this.perFolderCalls.push(args.path);
          return {
            result: {
              entries: perFolder[args.path] || [],
              has_more: false,
              cursor: "c",
            },
          };
        },
        filesListFolderContinue: async () => {
          throw new Error("not paged");
        },
      };
    }

    it("reads folders from one recursive listing, and an empty one as empty", async function () {
      const { createReaddir } = require("../sync/reset-to-blot");
      const stub = client(
        [folder("/A"), file("/A/x.md"), folder("/Empty"), file("/y.md")],
        {}
      );
      const readdir = await createReaddir(stub, "/", "", () => {});

      expect((await readdir("/", "/")).map((e) => e.name).sort()).toEqual([
        "A",
        "Empty",
        "y.md",
      ]);
      expect((await readdir("/A", "/a")).map((e) => e.name)).toEqual(["x.md"]);
      expect(await readdir("/Empty", "/empty")).toEqual([]);
      expect(stub.perFolderCalls).toEqual([]);
    });

    // An unmatched folder taken for empty would have its files removed
    it("lists a folder by itself when its path isn't in the listing", async function () {
      const { createReaddir } = require("../sync/reset-to-blot");
      const stub = client([file("/y.md")], {
        "/Other": [file("/Other/z.md")],
      });
      const readdir = await createReaddir(stub, "/", "", () => {});

      expect((await readdir("/Other", "/other")).map((e) => e.name)).toEqual([
        "z.md",
      ]);
      expect(stub.perFolderCalls).toEqual(["/Other"]);
    });
  });
});
