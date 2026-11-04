describe("dropbox sync/index with a file over the download size limit", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const { blog_folder_dir } = require("config");
  const storage = require("storage/folder");

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
  const blogDirectory = join(blog_folder_dir, blogID);
  const originals = {};

  beforeEach(async function () {
    paths.forEach((path) => (originals[path] = require.cache[path]));
    await fs.ensureDir(blogDirectory);
  });

  afterEach(async function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    await fs.remove(blogDirectory);
  });

  function run(content_hash) {
    require.cache[lockPath] = {
      exports: function (_blogID, callback) {
        callback(
          null,
          {
            log: function () {},
            status: function () {},
            path: blogDirectory,
            update: (path, cb) => cb(),
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
      exports: { set: (_id, _values, callback) => callback(null) },
    };
    let calls = 0;
    require.cache[deltaPath] = {
      exports: function () {
        return function (_cursor, callback) {
          const entries =
            calls++ === 0
              ? [
                  {
                    ".tag": "file",
                    name: "big.txt",
                    path_display: "/big.txt",
                    relative_path: "big.txt",
                    content_hash,
                    size: 200 * 1024 * 1024,
                  },
                ]
              : [];
          callback(null, { entries, cursor: "new", has_more: false });
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
    await fs.outputFile(join(blogDirectory, "big.txt"), "real contents");
    const { hash } = await storage.stat(blogID, "/big.txt", { hash: true });

    await run(hash);

    expect(await fs.readFile(join(blogDirectory, "big.txt"), "utf8")).toEqual(
      "real contents"
    );
  });

  it("writes an empty placeholder when the local copy differs or is absent", async function () {
    await fs.outputFile(join(blogDirectory, "big.txt"), "something else");
    await run("not-the-local-hash");
    expect(await fs.readFile(join(blogDirectory, "big.txt"), "utf8")).toEqual("");

    await fs.remove(join(blogDirectory, "big.txt"));
    await run("not-the-local-hash");
    expect(await fs.readFile(join(blogDirectory, "big.txt"), "utf8")).toEqual("");
  });
});
