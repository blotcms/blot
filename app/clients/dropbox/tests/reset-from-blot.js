describe("dropbox resetFromBlot", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const { blog_folder_dir } = require("config");

  const resetPath = require.resolve("../sync/reset-from-blot");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const uploadPath = require.resolve("../util/upload");

  const blogID = "blog_resetfromblottest" + Date.now();
  const blogDirectory = join(blog_folder_dir, blogID);
  const originals = {};
  let saved;
  let uploadCalls;

  beforeEach(async function () {
    saved = [];
    uploadCalls = [];
    [resetPath, createClientPath, databasePath, uploadPath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
    await fs.ensureDir(blogDirectory);
  });

  afterEach(async function () {
    delete require.cache[resetPath];
    [createClientPath, databasePath, uploadPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    if (originals[resetPath]) require.cache[resetPath] = originals[resetPath];
    await fs.remove(blogDirectory);
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
      exports: function (_blogID, callback) {
        callback(
          null,
          {
            usersGetSpaceUsage: async () => ({ result: spaceUsage }),
            filesListFolderGetLatestCursor: async () => ({
              result: { cursor: "new-cursor" },
            }),
            filesListFolder: async ({ path }) => {
              const entries = (remote && remote[path || "/"]) || [];
              return { result: { entries, has_more: false, cursor: "c" } };
            },
          },
          { folder_id: "" }
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
    require.cache[uploadPath] = {
      exports: function (client, source, destination, callback) {
        uploadCalls.push(destination);
        uploadBehavior(callback);
      },
    };
    delete require.cache[resetPath];
    return require("../sync/reset-from-blot");
  }

  it("aborts before uploading anything when the pre-flight quota check fails", async function () {
    // 1000 bytes on disk, but only 1 byte free in Dropbox.
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(1000));

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
    expect(
      saved.some((values) => values.error_code === 507)
    ).toEqual(true);
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  it("stops the transfer and does not report success when an upload hits insufficient_space mid-transfer", async function () {
    await fs.outputFile(join(blogDirectory, "a.txt"), "hello");

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
    expect(
      saved.some((values) => values.error_code === 507)
    ).toEqual(true);
    // The cursor/error_code:0 "success" write must never happen.
    expect(saved.some((values) => "cursor" in values)).toEqual(false);
  });

  it("does not report success when a non-quota upload failure occurs", async function () {
    await fs.outputFile(join(blogDirectory, "a.txt"), "hello");

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
    await fs.outputFile(join(blogDirectory, "a.txt"), "hello");

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

  it("does not count bytes already sitting in the target Dropbox folder against the quota check", async function () {
    // 1000 bytes on disk, but only 5 bytes free - a naive check comparing
    // the full local size against free space would abort here. Since 999 of
    // those bytes are already sitting in the target Dropbox folder (this is
    // a retry of a previously-interrupted transfer), the actual net bytes
    // needed (1) fits in the 5 free bytes reported, so the transfer should
    // proceed instead of being blocked.
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(1000));

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
    expect(
      saved.some((values) => values.error_code === 507)
    ).toEqual(false);
    expect(
      saved.some((values) => values.cursor === "new-cursor")
    ).toEqual(true);
  });

  it("falls back to the shared team pool when the per-user limit is alert_only (not a hard cap)", async function () {
    // Only 1 byte allocated to this member specifically, which would block
    // a 1000-byte transfer if treated as a hard cap - but alert_only is a
    // notification-only limit (Dropbox's own docs: sync isn't stopped by
    // it), so the real constraint is the shared team pool, which has room.
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(1000));

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
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(1000));

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
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(500));

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
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(500));

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
    await fs.outputFile(join(blogDirectory, "a.txt"), Buffer.alloc(100));

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
