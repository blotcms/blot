describe("google drive resetToDrive empty files and placeholders", function () {
  const resetPath = require.resolve("../sync/resetToDrive");
  const paths = {
    storage: require.resolve("storage/folder"),
    database: require.resolve("../database"),
    createDriveClient: require.resolve("../serviceAccount/createDriveClient"),
    checkWeCanContinue: require.resolve("../util/checkWeCanContinue"),
    driveReaddir: require.resolve("../sync/util/driveReaddir"),
    localReaddir: require.resolve("../sync/util/localReaddir"),
  };
  const originals = new Map();
  let created;
  let updated;
  let messages;

  function mock(path, exportsValue) {
    if (!originals.has(path)) originals.set(path, require.cache[path]);
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: exportsValue,
    };
  }

  function load(local, remote, placeholders = []) {
    const drive = {
      files: {
        create: async ({ resource }) => {
          created.push(resource.name);
          return { data: { id: "id-" + resource.name } };
        },
        update: async ({ fileId }) => {
          updated.push(fileId);
          return { data: {} };
        },
        delete: async () => {},
      },
    };
    mock(paths.storage, {
      createReadStream: () => "stream",
      stat: async (_blogID, path) =>
        placeholders.includes(path) ? { placeholder: true } : {},
    });
    mock(paths.database, {
      blog: {
        get: async () => ({ folderId: "root", serviceAccountId: "sa" }),
      },
      folder: () => ({
        reset: async () => {},
        set: () => {},
        getAllApplied: async () => new Map(),
      }),
    });
    mock(paths.createDriveClient, async () => drive);
    mock(paths.checkWeCanContinue, () => async () => {});
    mock(paths.driveReaddir, async () => remote);
    mock(paths.localReaddir, async () => local);
    delete require.cache[resetPath];
    return require(resetPath);
  }

  beforeEach(function () {
    created = [];
    updated = [];
    messages = [];
  });

  afterEach(function () {
    originals.forEach(function (cached, path) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    });
    originals.clear();
    delete require.cache[resetPath];
  });

  const file = (name, size) => ({
    name,
    size,
    isDirectory: false,
    modified: 1000,
    modifiedTime: new Date(1000).toISOString(),
  });

  it("skips placeholders, uploads empty files, and never overwrites a remote file with one", async function () {
    const resetToDrive = load(
      [
        file("placeholder.pdf", 0),
        file("empty.txt", 0),
        file("overwrites.pdf", 0),
        file("post.txt", 5),
      ],
      [{ name: "overwrites.pdf", id: "remote-1", size: "9000" }],
      ["/placeholder.pdf"]
    );

    await resetToDrive("blog", (...args) => messages.push(args.join(" ")));

    expect(created.sort()).toEqual(["empty.txt", "post.txt"]);
    expect(updated).toEqual([]);
    expect(messages.some((m) => /Skipped 1 placeholder /.test(m))).toBe(true);
  });

  it("does not overwrite a Google App file, which lists no size, with an empty one", async function () {
    const resetToDrive = load(
      [file("sheet.gsheet", 0)],
      [
        {
          name: "sheet.gsheet",
          id: "remote-3",
          mimeType: "application/vnd.google-apps.spreadsheet",
        },
      ]
    );

    await resetToDrive("blog", () => {});

    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("still updates a changed non-empty file", async function () {
    const resetToDrive = load(
      [file("post.txt", 5)],
      [{ name: "post.txt", id: "remote-2", size: "9000" }]
    );

    await resetToDrive("blog", () => {});

    expect(updated).toEqual(["remote-2"]);
  });
});
