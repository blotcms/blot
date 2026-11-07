describe("dropbox resetFromBlot", function () {
  const storage = require("storage/folder");

  const resetPath = require.resolve("../sync/reset-from-blot");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const uploadPath = require.resolve("../util/upload");
  // persistError.js does `const database = require("../database")` once,
  // at module load. Its cache entry has to be cleared alongside
  // databasePath's or a persistError already loaded (with the real,
  // Redis-backed database module bound in its closure) from an earlier
  // spec file keeps using that instead of the mock below.
  const persistErrorPath = require.resolve("../util/persistError");

  const blogID = "blog_resetfromblottest" + Date.now();
  const originals = {};
  let saved;
  let uploadCalls;

  beforeEach(async function () {
    saved = [];
    uploadCalls = [];
    [
      resetPath,
      createClientPath,
      databasePath,
      uploadPath,
      persistErrorPath,
    ].forEach((path) => (originals[path] = require.cache[path]));
  });

  afterEach(async function () {
    delete require.cache[resetPath];
    [createClientPath, databasePath, uploadPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    delete require.cache[persistErrorPath];
    if (originals[persistErrorPath]) {
      require.cache[persistErrorPath] = originals[persistErrorPath];
    }
    if (originals[resetPath]) require.cache[resetPath] = originals[resetPath];
    await storage.removeAll(blogID);
  });

  // Mirrors the shape of an error the Dropbox SDK throws for a filesUpload
  // call that fails because the account is out of space: an HTTP 409 whose
  // JSON body has an error_summary starting with "path/insufficient_space/".
  function insufficientSpaceSdkError() {
    const error = new Error("insufficient_space");
    error.status = 409;
    error.error = { error_summary: "path/insufficient_space/.." };
    return error;
  }

  function load({ spaceUsage, remote, uploadBehavior }) {
    require.cache[createClientPath] = {
      exports: async function () {
        return {
          error: null,
          client: {
            filesCreateFolder: async () => ({ result: {} }),
            usersGetSpaceUsage: async () => ({ result: spaceUsage }),
            filesListFolderGetLatestCursor: async () => ({
              result: { cursor: "new-cursor" },
            }),
            filesListFolder: async ({ path }) => {
              const entries = (remote && remote[path || "/"]) || [];
              return { result: { entries, has_more: false, cursor: "c" } };
            },
          },
          account: { folder_id: "" },
        };
      },
    };
    require.cache[databasePath] = {
      exports: {
        set: async function (_blogID, values) {
          saved.push(values);
        },
        // Mirrors database.js's real setError closely enough for these
        // specs: only a persistable classification writes anything, and
        // what it writes is the same error_code/error_source/error_since
        // shape so `saved` reflects it the same way a direct set() would.
        setError: async function (_blogID, classification) {
          if (!classification || !classification.persist) return;
          saved.push({
            error_code: classification.status || 0,
            error_source: classification.source || "",
            error_since: Date.now(),
          });
        },
      },
    };
    require.cache[uploadPath] = {
      exports: function (client, source, destination) {
        uploadCalls.push(destination);
        return new Promise((resolve, reject) =>
          uploadBehavior((err) => (err ? reject(err) : resolve()))
        );
      },
    };
    // Force persistError.js to reload so its own `require("../database")`
    // picks up the mock above instead of a stale reference cached from an
    // earlier spec file.
    delete require.cache[persistErrorPath];
    delete require.cache[resetPath];
    return require("../sync/reset-from-blot");
  }

  it("aborts before uploading anything when the pre-flight quota check fails", async function () {
    // 1000 bytes on disk, but only 1 byte free in Dropbox.
    await storage.write(blogID, "/a.txt", Buffer.alloc(1000));

    const resetFromBlot = load({
      spaceUsage: {
        used: 999,
        allocation: { ".tag": "individual", allocated: 1000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.code).toEqual("DROPBOX_INSUFFICIENT_SPACE");
    expect(uploadCalls.length).toEqual(0);
    expect(saved.some((values) => values.error_code === 507)).toEqual(true);
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  it("stops the transfer and does not report success when an upload hits insufficient_space mid-transfer", async function () {
    await storage.write(blogID, "/a.txt", "hello");

    const resetFromBlot = load({
      // Plenty of free space reported up front, so the pre-flight check
      // passes and the failure only happens once we actually try to upload.
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(insufficientSpaceSdkError()),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.code).toEqual("DROPBOX_INSUFFICIENT_SPACE");
    expect(uploadCalls.length).toEqual(1);
    expect(saved.some((values) => values.error_code === 507)).toEqual(true);
    // The cursor/error_code:0 "success" write must never happen.
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  it("does not report success when a non-quota upload failure occurs", async function () {
    await storage.write(blogID, "/a.txt", "hello");

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(new Error("network blip")),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.code).toEqual("DROPBOX_TRANSFER_INCOMPLETE");
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  it("succeeds, sets the cursor and clears transfer_pending when every file transfers", async function () {
    await storage.write(blogID, "/a.txt", "hello");

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    await resetFromBlot(blogID, () => {}, { aborted: false });

    expect(uploadCalls.length).toEqual(1);
    expect(
      saved.some(
        (values) =>
          values.cursor === "new-cursor" &&
          values.error_code === 0 &&
          values.transfer_pending === false
      )
    ).toEqual(true);
  });

  it("renames paths which differ only by case before uploading, since Dropbox is case-insensitive", async function () {
    await storage.write(blogID, "/a.txt", "lower");
    await storage.write(blogID, "/A.txt", "upper");

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    const updated = [];
    // Same shape as sync()'s folder.update: callback-style, promisified by
    // the setup route before it is handed to resetFromBlot.
    const folderUpdate = (path, callback) => {
      updated.push(path);
      callback();
    };
    await resetFromBlot(
      blogID,
      () => {},
      { aborted: false },
      require("util").promisify(folderUpdate)
    );

    expect(uploadCalls.length).toEqual(2);
    expect(
      new Set(uploadCalls.map((destination) => destination.toLowerCase())).size
    ).toEqual(2);
    expect(uploadCalls.some((d) => d.includes("(conflict)"))).toEqual(true);
    expect(updated).toContain("/");
    expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
      true
    );
  });

  it("leaves ignored paths such as case-distinct refs inside .git untouched when resolving case conflicts", async function () {
    await storage.write(blogID, "/a.txt", "hello");
    await storage.write(blogID, "/.git/refs/heads/Feature", "1");
    await storage.write(blogID, "/.git/refs/heads/feature", "2");

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    await resetFromBlot(blogID, () => {}, { aborted: false });

    expect(
      (await storage.listNames(blogID, "/.git/refs/heads"))
        .map((e) => e.name)
        .sort()
    ).toEqual(["Feature", "feature"]);
    expect(uploadCalls.length).toEqual(1);
  });

  it("does not merge case-conflicting folders that contain ignored paths", async function () {
    await storage.write(blogID, "/a/.git/HEAD", "one");
    await storage.write(blogID, "/A/.git/HEAD", "two");

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    await resetFromBlot(blogID, () => {}, { aborted: false });

    const top = (await storage.listNames(blogID, "/"))
      .map((e) => e.name)
      .sort();
    expect(top.length).toEqual(2);
    expect(top.some((name) => name.includes("(conflict)"))).toEqual(true);
    const contents = [];
    for (const name of top) {
      expect(
        (await storage.listNames(blogID, "/" + name + "/.git")).map(
          (e) => e.name
        )
      ).toEqual(["HEAD"]);
      contents.push(
        (await storage.read(blogID, "/" + name + "/.git/HEAD")).toString()
      );
    }
    expect(contents.sort()).toEqual(["one", "two"]);
  });

  it("does not upload empty files, which may be placeholders, or overwrite a remote file with one", async function () {
    await storage.write(blogID, "/placeholder.pdf", Buffer.from(""));
    await storage.write(blogID, "/new-empty.txt", Buffer.from(""));
    await storage.write(blogID, "/a.txt", Buffer.from("hello"));

    const messages = [];
    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: { ".tag": "individual", allocated: 1000000 },
      },
      remote: {
        "/": [
          {
            ".tag": "file",
            name: "placeholder.pdf",
            path_display: "/placeholder.pdf",
            content_hash: "real-content-hash",
            size: 5000,
            server_modified: "2026-01-01T00:00:00Z",
          },
        ],
      },
      uploadBehavior: (callback) => callback(null),
    });

    await resetFromBlot(blogID, (...args) => messages.push(args.join(" ")), {
      aborted: false,
    });

    expect(uploadCalls).toEqual(["/a.txt"]);
    expect(messages.some((m) => /Skipped 2 empty files/.test(m))).toEqual(true);
    expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
      true
    );
  });

  it("does not count bytes already sitting in the target Dropbox folder against the quota check", async function () {
    // 1000 bytes on disk, but only 5 bytes free - a naive check comparing
    // the full local size against free space would abort here. Since 999 of
    // those bytes are already sitting in the target Dropbox folder (this is
    // a retry of a previously-interrupted transfer), the actual net bytes
    // needed (1) fits in the 5 free bytes reported, so the transfer should
    // proceed instead of being blocked.
    await storage.write(blogID, "/a.txt", Buffer.alloc(1000));

    const resetFromBlot = load({
      spaceUsage: {
        used: 995,
        allocation: { ".tag": "individual", allocated: 1000 },
      },
      remote: {
        "/": [
          {
            ".tag": "file",
            name: "a.txt",
            path_display: "/a.txt",
            content_hash: "different-hash-so-it-still-gets-reuploaded",
            size: 999,
            server_modified: "2026-01-01T00:00:00Z",
          },
        ],
      },
      uploadBehavior: (callback) => callback(null),
    });

    await resetFromBlot(blogID, () => {}, { aborted: false });

    expect(uploadCalls.length).toEqual(1);
    expect(saved.some((values) => values.error_code === 507)).toEqual(false);
    expect(saved.some((values) => values.cursor === "new-cursor")).toEqual(
      true
    );
  });

  it("falls back to the shared team pool when the per-user limit is alert_only (not a hard cap)", async function () {
    // Only 1 byte allocated to this member specifically, which would block
    // a 1000-byte transfer if treated as a hard cap - but alert_only is a
    // notification-only limit (Dropbox's own docs: sync isn't stopped by
    // it), so the real constraint is the shared team pool, which has room.
    await storage.write(blogID, "/a.txt", Buffer.alloc(1000));

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: {
          ".tag": "team",
          allocated: 1000000,
          used: 0,
          user_within_team_space_allocated: 1,
          user_within_team_space_limit_type: { ".tag": "alert_only" },
        },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeUndefined();
    expect(uploadCalls.length).toEqual(1);
  });

  it("treats the per-user limit as a hard cap when it is stop_sync", async function () {
    await storage.write(blogID, "/a.txt", Buffer.alloc(1000));

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: {
          ".tag": "team",
          allocated: 1000000,
          used: 0,
          user_within_team_space_allocated: 1,
          user_within_team_space_limit_type: { ".tag": "stop_sync" },
        },
      },
      remote: {},
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.code).toEqual("DROPBOX_INSUFFICIENT_SPACE");
    expect(uploadCalls.length).toEqual(0);
  });

  it("does not block a zero-net-growth retry even when the account is already over quota", async function () {
    // used (2000) > allocated (1000) makes freeSpaceBytes negative (-1000).
    // Naively comparing netBytesToUpload > freeSpaceBytes would reject this
    // forever (0 > -1000), even though this transfer needs zero additional
    // bytes: a 500-byte copy of a.txt is already on Dropbox.
    await storage.write(blogID, "/a.txt", Buffer.alloc(500));

    const resetFromBlot = load({
      spaceUsage: {
        used: 2000,
        allocation: { ".tag": "individual", allocated: 1000 },
      },
      remote: {
        "/": [
          {
            ".tag": "file",
            name: "a.txt",
            path_display: "/a.txt",
            content_hash: "different-hash-so-it-still-gets-reuploaded",
            size: 500,
            server_modified: "2026-01-01T00:00:00Z",
          },
        ],
      },
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error).toBeUndefined();
    expect(uploadCalls.length).toEqual(1);
  });

  it("does not credit stale remote files at other paths against the quota check", async function () {
    // walk() may upload a.txt before it deletes other.txt, so the 500 bytes
    // other.txt occupies can't be counted as free during the transfer.
    await storage.write(blogID, "/a.txt", Buffer.alloc(500));

    const resetFromBlot = load({
      spaceUsage: {
        used: 1000,
        allocation: { ".tag": "individual", allocated: 1000 },
      },
      remote: {
        "/": [
          {
            ".tag": "file",
            name: "other.txt",
            path_display: "/other.txt",
            content_hash: "unrelated",
            size: 500,
            server_modified: "2026-01-01T00:00:00Z",
          },
        ],
      },
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error && error.code).toEqual("DROPBOX_INSUFFICIENT_SPACE");
    expect(uploadCalls.length).toEqual(0);
  });

  it("applies the shared team pool as well as a stop_sync member cap", async function () {
    // Plenty of room under the member's own cap, but the team pool is full.
    await storage.write(blogID, "/a.txt", Buffer.alloc(100));

    const resetFromBlot = load({
      spaceUsage: {
        used: 0,
        allocation: {
          ".tag": "team",
          allocated: 1000,
          used: 1000,
          user_within_team_space_allocated: 1000000,
          user_within_team_space_limit_type: { ".tag": "stop_sync" },
        },
      },
      uploadBehavior: (callback) => callback(null),
    });

    let error;
    try {
      await resetFromBlot(blogID, () => {}, { aborted: false });
    } catch (err) {
      error = err;
    }

    expect(error && error.code).toEqual("DROPBOX_INSUFFICIENT_SPACE");
    expect(uploadCalls.length).toEqual(0);
  });
});
