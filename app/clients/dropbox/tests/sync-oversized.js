describe("dropbox sync/index with a file over the download size limit", function () {
  const storage = require("storage/folder");
  const constants = require("../util/constants");

  const syncPath = require.resolve("../sync");
  const lockPath = require.resolve("sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const deltaPath = require.resolve("../delta");
  const persistErrorPath = require.resolve("../util/persistError");
  const paths = [
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

  function run(content_hash, size) {
    require.cache[lockPath] = {
      exports: function (_blogID, callback) {
        callback(
          null,
          {
            log: function () {},
            status: function () {},
            update: async () => {},
          },
          (err, cb) => cb(err)
        );
      },
    };
    require.cache[createClientPath] = {
      exports: (_id, callback) =>
        callback(null, {}, { folder_id: "", cursor: "old", error_code: 0 }),
    };
    require.cache[databasePath] = {
      exports: { set: async () => {} },
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
      sync({ id: blogID }, (err) => (err ? reject(err) : resolve()))
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

    await storage.remove(blogID, "/big.txt");
    await run("not-the-local-hash", 14);
    expect((await storage.read(blogID, "/big.txt")).toString()).toEqual("");
  });
});
