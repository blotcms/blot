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
    if (originals[databasePath]) require.cache[databasePath] = originals[databasePath];
    else delete require.cache[databasePath];
    delete require.cache[createFolderPath];
    if (originals[createFolderPath])
      require.cache[createFolderPath] = originals[createFolderPath];
  });

  function load(existingAccount) {
    require.cache[databasePath] = {
      exports: {
        get: function (_blogID, callback) {
          callback(null, existingAccount);
        },
        listBlogs: function (_accountID, callback) {
          // No other blogs on this Dropbox account - keeps checkAppFolder's
          // fall-through path (used when reuse doesn't apply) simple.
          callback(null, []);
        },
        set: function (_blogID, _values, callback) {
          callback(null);
        },
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
  });

  it("falls through to creating a new folder when the existing one can't be confirmed", async function () {
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
          throw new Error("path/not_found/..");
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
});
