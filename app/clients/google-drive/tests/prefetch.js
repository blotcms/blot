const crypto = require("crypto");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Readable } = require("stream");

describe("google drive prefetch", function () {
  const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
  let dir, prefetch, fetched;

  // A Drive client whose files hold the given text
  const drive = (files) => ({
    files: {
      get: async ({ fileId }) => {
        fetched.push(fileId);
        return { data: Readable.from([Buffer.from(files[fileId])]) };
      },
    },
  });

  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "prefetch-"));
    fetched = [];
    let n = 0;
    const module = { exports: {} };
    const stubs = {
      "helper/tempDir": () => dir,
      "helper/guid": () => "file-" + n++,
      "./verifyContent": require("../util/verifyContent"),
    };
    vm.runInNewContext(
      fs.readFileSync(require.resolve("../util/prefetch"), "utf8"),
      {
        module,
        exports: module.exports,
        setTimeout,
        clearTimeout,
        require: (name) => (name in stubs ? stubs[name] : require(name)),
      }
    );
    prefetch = module.exports;
  });

  afterEach(async function () {
    await prefetch.clear();
    await fs.remove(dir);
  });

  it("downloads a file once and hands it over, checked against its md5", async function () {
    prefetch.start(drive({ a: "hello" }), {
      id: "a",
      md5Checksum: md5("hello"),
      size: 5,
    });
    prefetch.start(drive({ a: "hello" }), {
      id: "a",
      md5Checksum: md5("hello"),
      size: 5,
    });

    const taken = await prefetch.take("a", md5("hello"));
    expect(await fs.readFile(taken.tempPath, "utf8")).toBe("hello");
    expect(taken.hashes.checksum).toBe(md5("hello"));
    expect(fetched).toEqual(["a"]);
    // Taken once
    expect(await prefetch.take("a", md5("hello"))).toBe(null);
  });

  it("only hands over the bytes asked for", async function () {
    prefetch.start(drive({ a: "hello" }), {
      id: "a",
      md5Checksum: md5("hello"),
    });

    expect(await prefetch.take("a", md5("other"))).toBe(null);
  });

  it("hands over nothing when the download doesn't match its md5, and deletes it", async function () {
    prefetch.start(drive({ a: "changed since" }), {
      id: "a",
      md5Checksum: md5("hello"),
    });

    expect(await prefetch.take("a", md5("hello"))).toBe(null);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("leaves large files and files with no md5 to the apply", async function () {
    prefetch.start(drive({ a: "x" }), {
      id: "a",
      md5Checksum: md5("x"),
      size: prefetch.MAX_BYTES + 1,
    });
    prefetch.start(drive({ b: "x" }), { id: "b" });

    expect(await prefetch.take("a", md5("x"))).toBe(null);
    expect(fetched).toEqual([]);
  });

  it("hands over nothing for a prefetch still queued, and never starts it", async function () {
    // Four downloads that never finish fill every slot
    const stuck = {
      files: {
        get: async ({ fileId }) => {
          fetched.push(fileId);
          return new Promise(() => {});
        },
      },
    };
    for (const id of ["a", "b", "c", "d"])
      prefetch.start(stuck, { id, md5Checksum: md5(id) });
    prefetch.start(drive({ e: "small" }), {
      id: "e",
      md5Checksum: md5("small"),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(await prefetch.take("e", md5("small"))).toBe(null);
    expect(fetched).toEqual(["a", "b", "c", "d"]);
  });
});
