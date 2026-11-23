describe("dropbox sync/index with a file over the download size limit", function () {
  const storage = require("storage/folder");
  const constants = require("../util/constants");

  const syncPath = require.resolve("../sync");
  const lockPath = require.resolve("sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const deltaPath = require.resolve("../delta");
  const persistErrorPath = require.resolve("../util/persistError");
  const downloadPath = require.resolve("../util/download");
  const paths = [
    downloadPath,
    syncPath,
    lockPath,
    createClientPath,
    databasePath,
    deltaPath,
    persistErrorPath,
  ];

  const blogID = "blog_syncoversized" + Date.now();
  const originals = {};
  let maxFileSize;
  let logs;
  let saved;

  // A limit below the fixtures' sizes, so a matching local copy can have the
  // same size as the Dropbox file. sync/index reads it when it loads.
  beforeEach(function () {
    paths.forEach((path) => (originals[path] = require.cache[path]));
    maxFileSize = constants.MAX_FILE_SIZE;
    constants.MAX_FILE_SIZE = 4;
  });

  afterEach(async function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    constants.MAX_FILE_SIZE = maxFileSize;
    await storage.removeAll(blogID);
  });

  // downloadError: what a (stubbed) download throws; without it the real
  // download runs
  function run(content_hash, size, downloadError) {
    logs = [];
    saved = [];
    if (downloadError)
      require.cache[downloadPath] = {
        exports: async function () {
          throw downloadError;
        },
      };
    else delete require.cache[downloadPath];
    require.cache[lockPath] = {
      exports: async function (_blogID, fn) {
        return fn({
          signal: new AbortController().signal,
          log: (...args) => logs.push(args.join(" ")),
          status: function () {},
          update: async () => {},
        });
      },
    };
    require.cache[createClientPath] = {
      exports: async () => ({
        error: null,
        client: {},
        account: { folder_id: "", cursor: "old", error_code: 0 },
      }),
    };
    require.cache[databasePath] = {
      exports: {
        set: async (_id, values) => saved.push(values),
        setError: async () => {},
      },
    };
    let calls = 0;
    require.cache[deltaPath] = {
      exports: function () {
        return async function (_cursor) {
          const entries =
            calls++ === 0
              ? [
                  {
                    ".tag": "file",
                    name: "big.txt",
                    path_display: "/big.txt",
                    relative_path: "big.txt",
                    content_hash,
                    size,
                  },
                ]
              : [];
          return { entries, cursor: "new", has_more: false };
        };
      },
    };
    delete require.cache[persistErrorPath];
    delete require.cache[syncPath];
    const sync = require("../sync");
    return new Promise((resolve, reject) =>
      sync({ id: blogID }).then(resolve, reject)
    );
  }

  it("keeps a local copy whose content hash matches", async function () {
    await storage.write(blogID, "/big.txt", "real contents");
    const { hash, size } = await storage.stat(blogID, "/big.txt", {
      hash: true,
    });

    await run(hash, size);

    expect((await storage.read(blogID, "/big.txt")).toString()).toEqual(
      "real contents"
    );
  });

  it("writes an empty placeholder when the local copy differs or is absent", async function () {
    await storage.write(blogID, "/big.txt", "something else");
    await run("not-the-local-hash", 14);
    expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");
    expect((await storage.stat(blogID, "/big.txt")).flags).toEqual([
      { code: "SYNC_TOO_LARGE", size: 14, limit: 4 },
    ]);

    await storage.remove(blogID, "/big.txt");
    await run("not-the-local-hash", 14);
    expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");
    expect((await storage.stat(blogID, "/big.txt")).flags).toEqual([
      { code: "SYNC_TOO_LARGE", size: 14, limit: 4 },
    ]);
  });

  describe("a file Dropbox refuses to download", function () {
    const refused = (summary, status = 409) =>
      Object.assign(new Error("Response failed with a 409 code"), {
        status,
        error: { error_summary: summary },
      });

    it("logs the blog and the path, and carries on", async function () {
      await run("hash", 3, refused("path/restricted_content/.."));

      const line = logs.find((entry) => /refused to download/.test(entry));
      expect(line).toContain("big.txt");
      expect(line).toContain(blogID);
      expect(line).toContain("path/restricted_content");
    });

    it("still stops the sync for revoked access, without moving the cursor", async function () {
      await run("hash", 3, refused("invalid_access_token/..", 401));

      expect(saved.some((values) => values.cursor === "new")).toEqual(false);
    });

    it("moves the cursor past a refused file", async function () {
      await run("hash", 3, refused("path/restricted_content/.."));

      expect(saved.some((values) => values.cursor === "new")).toEqual(true);
    });
  });
});
