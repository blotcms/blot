const assert = require("assert");
// Exercise the real downloader with controlled streams and no Drive account.
const fs = require("fs");
const vm = require("vm");
const { Readable, Writable, PassThrough } = require("stream");

function load(stubs) {
  // Nothing prefetched, unless a spec says otherwise
  stubs = { "./prefetch": { take: async () => null }, ...stubs };
  const module = {
    exports: {},
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../util/download"), "utf8"),
    {
      module,
      exports: module.exports,
      Buffer,
      console,
      require: (name) =>
        Object.prototype.hasOwnProperty.call(stubs, name)
          ? stubs[name]
          : require(name),
    }
  );
  return module.exports;
}
describe("Drive download completion", function () {
  let moved,
    removed,
    source,
    writer,
    finishWrite,
    download,
    mismatchTemp,
    failAfterPublish;
  beforeEach(function () {
    finishWrite = undefined;
    mismatchTemp = false;
    failAfterPublish = false;
    moved = false;
    removed = false;
    source = Readable.from([Buffer.from("new contents")]);
    writer = new Writable({
      write(chunk, encoding, callback) {
        finishWrite = callback;
      },
    });
    download = load({
      "fs-extra": {
        createWriteStream: () => writer,
        remove: async () => {
          removed = true;
        },
      },
      "storage/folder": {
        writeFrom: async () => {
          moved = true;
        },
        // Nothing at the path until the download is published
        stat: async (blogID, path, options) => {
          if (!moved)
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          if (failAfterPublish) throw Error("stat failed after publication");
          return {
            isDirectory: false,
            size: 12,
            modified: 1000,
            sha1: options && options.sha1 ? "sha" : undefined,
          };
        },
      },
      "./localFile": async () => "/test-blog/file.txt",
      "colors/safe": {
        green: (x) => x,
      },
      debug: () => () => {},
      "helper/tempDir": () => "/test-temp",
      "helper/guid": () => "download",
      "./verifyContent": async (filename) => {
        if (filename.startsWith("/test-temp"))
          return mismatchTemp
            ? null
            : {
                checksum: "new",
                sha1: "sha",
              };
        throw Error(
          "the published file is checked by its SHA-1, not read again"
        );
      },
      config: {},
      "helper/hash": () => {},
      cheerio: {},
      yauzl: {},
      "../serviceAccount/hotDocPoller": {},
      "../database": {},
    });
  });

  function start() {
    return download(
      "blog",
      {
        files: {
          get: async () => ({
            data: source,
          }),
        },
      },
      "/file.txt",
      {
        id: "file",
        mimeType: "text/plain",
        md5Checksum: "new",
        modifiedTime: "2026-01-01T00:00:00Z",
      }
    );
  }
  async function writing() {
    while (!finishWrite) await new Promise((resolve) => setImmediate(resolve));
  }
  it("publishes only after the destination finishes", async function () {
    let resolved = false;
    const pending = start().then((result) => {
      resolved = true;
      return result;
    });
    await writing();
    expect(moved).toBe(false);
    expect(resolved).toBe(false);
    finishWrite();
    expect(await pending).toEqual({
      updated: true,
      verifiedContent: {
        checksum: "new",
        sha1: "sha",
      },
    });
    expect(moved).toBe(true);
  });
  it("does not publish media whose bytes disagree with the listed checksum", async function () {
    mismatchTemp = true;
    const pending = start();
    const rejected = assert.rejects(pending, /does not match/);
    await writing();
    finishWrite();
    await rejected;
    expect(moved).toBe(false);
    expect(removed).toBe(true);
  });
  it("still requests a rebuild when post-publication verification fails", async function () {
    failAfterPublish = true;
    const pending = start();
    await writing();
    finishWrite();
    expect(await pending).toEqual({
      updated: true,
      verifiedContent: null,
    });
    expect(moved).toBe(true);
  });
  it("rejects a late writer failure and cleans up without publishing", async function () {
    const pending = start();
    const rejection = assert.rejects(pending, /disk full/);
    await writing();
    finishWrite(new Error("disk full"));
    await rejection;
    expect(moved).toBe(false);
    expect(removed).toBe(true);
    expect(source.destroyed).toBe(true);
  });
  it("rejects a source failure and cleans up", async function () {
    source = new PassThrough();
    source.write("partial");
    const pending = start();
    const rejection = assert.rejects(pending, /connection lost/);
    await writing();
    source.destroy(new Error("connection lost"));
    await rejection;
    expect(moved).toBe(false);
    expect(removed).toBe(true);
    expect(writer.destroyed).toBe(true);
  });
});

describe("Drive download checksum optimization", function () {
  let stats, requested, download;

  beforeEach(function () {
    requested = false;
    stats = [];
    download = load({
      "fs-extra": {
        remove: async () => {},
      },
      // storage/folder's stat of the file, a different one on each call
      "storage/folder": {
        stat: async () => stats.shift(),
      },
      "./localFile": async () => "/test-blog/file.txt",
      "colors/safe": {
        green: (x) => x,
      },
      debug: () => () => {},
      "helper/tempDir": () => "/test-temp",
      "helper/guid": () => "download",
      "./verifyContent": async () => ({
        checksum: "same",
        sha1: "sha",
      }),
      config: {},
      "helper/hash": () => {},
      cheerio: {},
      yauzl: {},
      "../serviceAccount/hotDocPoller": {},
      "../database": {},
    });
  });

  function start() {
    return download(
      "blog",
      {
        files: {
          get: async () => {
            requested = true;
            throw Error("requested");
          },
        },
      },
      "/file.txt",
      {
        id: "file",
        mimeType: "text/plain",
        md5Checksum: "same",
      }
    );
  }

  it("does not request content when the local checksum matches", async function () {
    stats = [{ isDirectory: false, size: 4, modified: 1000.4, sha1: "sha" }];
    expect(await start()).toEqual({
      updated: false,
      verifiedContent: { checksum: "same", sha1: "sha" },
    });
    expect(requested).toBe(false);
  });

  it("does not vouch for a file whose bytes aren't the ones the index has", async function () {
    // Changed while it was hashed, say: the index has the new SHA-1
    stats = [{ isDirectory: false, size: 4, modified: 1000, sha1: "other" }];
    let error;
    try {
      await start();
    } catch (err) {
      error = err;
    }
    expect(error && error.message).toBe("requested");
    expect(requested).toBe(true);
  });
});

describe("Drive download of a prefetched file", function () {
  it("publishes the file the detection walk downloaded, without fetching it", async function () {
    const written = [];
    const download = load({
      "fs-extra": { remove: async () => {} },
      "storage/folder": {
        writeFrom: async (blogID, path, from, options) =>
          written.push([path, from, options]),
        stat: async (blogID, path, options) => {
          if (!written.length)
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return {
            isDirectory: false,
            size: 12,
            modified: 1000,
            sha1: options && options.sha1 ? "sha" : undefined,
          };
        },
      },
      "./prefetch": {
        take: async (id, md5) =>
          id === "file" && md5 === "new"
            ? {
                tempPath: "/test-temp/prefetched",
                hashes: { checksum: "new", sha1: "sha" },
                downloadedAt: 42,
              }
            : null,
      },
      "./localFile": async () => null,
      "colors/safe": { green: (x) => x },
      debug: () => () => {},
      "helper/tempDir": () => "/test-temp",
      "helper/guid": () => "download",
      "./verifyContent": async () => null,
      config: {},
      "helper/hash": () => {},
      cheerio: {},
      "../serviceAccount/hotDocPoller": {},
      "../database": {},
    });

    const result = await download(
      "blog",
      {
        files: {
          get: async () => {
            throw new Error("should not be fetched");
          },
        },
      },
      "/file.txt",
      { id: "file", mimeType: "text/plain", md5Checksum: "new" }
    );

    expect(written).toEqual([
      ["/file.txt", "/test-temp/prefetched", { move: true }],
    ]);
    expect(result).toEqual({
      updated: true,
      prefetched: true,
      downloadedAt: 42,
      verifiedContent: {
        checksum: "new",
        sha1: "sha",
      },
    });
  });
});
