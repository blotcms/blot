describe("dropbox createFolder reuses a partially-transferred folder on retry", function () {
  // Unit-style, stubbed: tests/setup/createFolder.js (and the rest of
  // tests/setup/*) exercise this against a real Dropbox account in CI, but
  // that harness always starts from a blog with no prior Dropbox account, so
  // it can't exercise the "retrying an incomplete transfer" branch added
  // here. Stub the client and database instead.
  const createFolderPath = require.resolve("../../routes/setup/createFolder");
  const databasePath = require.resolve("clients/dropbox/database");

  const blogID = "blog_createfolderreusetest" + Date.now();
  const originals = {};

  beforeEach(function () {
    [createFolderPath, databasePath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
  });

  afterEach(function () {
    if (originals[databasePath])
      require.cache[databasePath] = originals[databasePath];
    else delete require.cache[databasePath];
    delete require.cache[createFolderPath];
    if (originals[createFolderPath])
      require.cache[createFolderPath] = originals[createFolderPath];
  });

  // others maps the IDs of other blogs on the Dropbox account to their
  // accounts; previous is what the blog's last disconnect left behind
  function load(existingAccount, { previous = null, others = {} } = {}) {
    require.cache[databasePath] = {
      exports: {
        get: async function (id) {
          return id === blogID ? existingAccount : others[id];
        },
        getPrevious: async function () {
          return previous;
        },
        listBlogs: async function () {
          // No other blogs on this Dropbox account by default - keeps
          // checkAppFolder's fall-through path (used when reuse doesn't
          // apply) simple.
          return Object.keys(others).map((id) => ({ id }));
        },
        set: async function () {},
      },
    };
    delete require.cache[createFolderPath];
    return require("../../routes/setup/createFolder");
  }

  it("reuses the existing folder instead of creating a new one", async function () {
    const existing = {
      account_id: "abc123",
      full_access: false,
      folder_id: "id:existingfolder",
      transfer_pending: true,
      error_code: 0,
    };

    let filesCreateFolderCalled = false;
    let getMetadataPath;

    const createFolder = load(existing);
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: false,
      client: {
        filesGetMetadata: async ({ path }) => {
          getMetadataPath = path;
          return {
            result: { ".tag": "folder", path_display: "/My Blog" },
          };
        },
        filesCreateFolder: async () => {
          filesCreateFolderCalled = true;
          throw new Error("should not create a new folder when reusing");
        },
      },
    };

    const result = await createFolder(account);

    expect(getMetadataPath).toEqual("id:existingfolder");
    expect(filesCreateFolderCalled).toEqual(false);
    expect(result.folder).toEqual("/My Blog");
    expect(result.folder_id).toEqual("id:existingfolder");
    // A retried transfer runs the normal reset, not the keepDropbox one
    expect(result.reused_folder).toBeUndefined();
  });

  // Mirrors the shape of an error the Dropbox SDK throws for a
  // filesGetMetadata call on a path that's genuinely gone: an HTTP 409 whose
  // JSON body has an error_summary starting "path/not_found/..." (see
  // GetMetadataErrorPath / LookupErrorNotFound in the SDK's type
  // definitions).
  function notFoundSdkError() {
    const error = new Error("not_found");
    error.status = 409;
    error.error = { error_summary: "path/not_found/.." };
    return error;
  }

  it("falls through to creating a new folder when the existing one is confirmed gone (404/not_found)", async function () {
    const existing = {
      account_id: "abc123",
      full_access: true,
      folder_id: "id:deletedfolder",
      transfer_pending: true,
      error_code: 0,
    };

    let filesCreateFolderCalled = false;

    const createFolder = load(existing);
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: true,
      client: {
        filesGetMetadata: async () => {
          throw notFoundSdkError();
        },
        filesCreateFolder: async ({ path }) => {
          filesCreateFolderCalled = true;
          return { result: { id: "id:newfolder", path_display: path } };
        },
      },
    };

    const result = await createFolder(account);

    expect(filesCreateFolderCalled).toEqual(true);
    expect(result.folder_id).toEqual("id:newfolder");
  });

  it("propagates a transient filesGetMetadata error instead of abandoning the folder", async function () {
    const existing = {
      account_id: "abc123",
      full_access: true,
      folder_id: "id:existingfolder",
      transfer_pending: true,
      error_code: 0,
    };

    let filesCreateFolderCalled = false;

    const createFolder = load(existing);
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: true,
      client: {
        filesGetMetadata: async () => {
          // A timeout, rate limit, or outage - not a confirmed "it's gone".
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
        filesCreateFolder: async ({ path }) => {
          filesCreateFolderCalled = true;
          return { result: { id: "id:newfolder", path_display: path } };
        },
      },
    };

    let error;
    try {
      await createFolder(account);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.status).toEqual(429);
    expect(filesCreateFolderCalled).toEqual(false);
  });

  it("does not reuse a folder from a different Dropbox account_id", async function () {
    const existing = {
      account_id: "different-account",
      full_access: true,
      folder_id: "id:existingfolder",
      transfer_pending: true,
      error_code: 0,
    };

    let filesCreateFolderCalled = false;
    let getMetadataCalled = false;

    const createFolder = load(existing);
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: true,
      client: {
        filesGetMetadata: async () => {
          getMetadataCalled = true;
          return { result: { ".tag": "folder", path_display: "/My Blog" } };
        },
        filesCreateFolder: async ({ path }) => {
          filesCreateFolderCalled = true;
          return { result: { id: "id:newfolder", path_display: path } };
        },
      },
    };

    await createFolder(account);

    expect(getMetadataCalled).toEqual(false);
    expect(filesCreateFolderCalled).toEqual(true);
  });

  it("does not reuse when the previous transfer already completed", async function () {
    const existing = {
      account_id: "abc123",
      full_access: true,
      folder_id: "id:existingfolder",
      transfer_pending: false,
      error_code: 0,
    };

    let getMetadataCalled = false;
    let filesCreateFolderCalled = false;

    const createFolder = load(existing);
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: true,
      client: {
        filesGetMetadata: async () => {
          getMetadataCalled = true;
          return { result: { ".tag": "folder", path_display: "/My Blog" } };
        },
        filesCreateFolder: async ({ path }) => {
          filesCreateFolderCalled = true;
          return { result: { id: "id:newfolder", path_display: path } };
        },
      },
    };

    await createFolder(account);

    expect(getMetadataCalled).toEqual(false);
    expect(filesCreateFolderCalled).toEqual(true);
  });

  it("propagates a database read failure instead of falling through to mkdir", async function () {
    require.cache[databasePath] = {
      exports: {
        get: async function () {
          throw new Error("redis blip");
        },
        listBlogs: async function () {
          return [];
        },
        set: async function () {},
      },
    };
    delete require.cache[createFolderPath];
    const createFolder = require("../../routes/setup/createFolder");

    let filesCreateFolderCalled = false;
    const account = {
      blog: { id: blogID, title: "My Blog" },
      account_id: "abc123",
      full_access: true,
      client: {
        filesGetMetadata: async () => ({
          result: { ".tag": "folder", path_display: "/My Blog" },
        }),
        filesCreateFolder: async ({ path }) => {
          filesCreateFolderCalled = true;
          return { result: { id: "id:newfolder", path_display: path } };
        },
      },
    };

    let error;
    try {
      await createFolder(account);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toEqual("redis blip");
    expect(filesCreateFolderCalled).toEqual(false);
  });

  describe("on reconnect", function () {
    const previous = { account_id: "abc123", folder_id: "id:oldfolder" };

    function reconnect(options, account_id = "abc123") {
      const calls = { metadata: [], create: [] };
      const createFolder = load(null, options);
      const account = {
        blog: { id: blogID, title: "My Blog" },
        account_id,
        full_access: true,
        client: {
          filesGetMetadata: async ({ path }) => {
            calls.metadata.push(path);
            // Renamed while the blog was disconnected
            return { result: { ".tag": "folder", path_display: "/Renamed" } };
          },
          filesCreateFolder: async ({ path }) => {
            calls.create.push(path);
            return { result: { id: "id:newfolder", path_display: path } };
          },
        },
      };
      return createFolder(account).then((result) => ({ result, calls }));
    }

    it("reuses the folder the blog used before it disconnected, at its current path", async function () {
      const { result, calls } = await reconnect({ previous });

      expect(calls.metadata).toEqual(["id:oldfolder"]);
      expect(calls.create).toEqual([]);
      expect(result.folder).toEqual("/Renamed");
      expect(result.folder_id).toEqual("id:oldfolder");
      expect(result.reused_folder).toBe(true);
    });

    it("creates a new folder on a different Dropbox account", async function () {
      const { result, calls } = await reconnect({ previous }, "other-account");

      expect(calls.metadata).toEqual([]);
      expect(result.folder_id).toEqual("id:newfolder");
      expect(result.reused_folder).toBeUndefined();
    });

    it("creates a new folder when another blog on the account uses the old one", async function () {
      const others = {
        blog_other: {
          full_access: true,
          folder: "/x",
          folder_id: "id:oldfolder",
        },
      };
      const { result, calls } = await reconnect({ previous, others });

      expect(calls.metadata).toEqual([]);
      expect(result.folder_id).toEqual("id:newfolder");
    });

    it("creates a new folder when there is no previous folder", async function () {
      const { result } = await reconnect({});

      expect(result.folder_id).toEqual("id:newfolder");
    });
  });
});
