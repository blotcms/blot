const folder = require("storage/folder");

const download = require("../util/download");

describe("dropbox download", function () {
  const blogID = "blog_downloadtest" + Date.now();
  const destination = "/post.txt";

  afterEach(async function () {
    await folder.removeAll(blogID);
    await require("../util/hashes").drop(blogID);
  });

  it("resolves to the written bytes' SHA-1 and content_hash, and records them", async function () {
    const crypto = require("crypto");
    const contentHash = crypto
      .createHash("sha256")
      .update("anything")
      .digest("hex");

    const pair = await download(
      {
        filesDownload: async () => ({
          result: { fileBinary: Buffer.from("hi"), content_hash: contentHash },
        }),
      },
      "/post.txt",
      blogID,
      destination,
      { metadata: { path_display: "/post.txt", size: 2 } }
    );

    const sha1 = crypto.createHash("sha1").update("hi").digest("hex");
    expect(pair).toEqual({ sha1, content_hash: contentHash });
    expect((await folder.stat(blogID, destination, { sha1: true })).sha1).toBe(
      sha1
    );
    const known = await require("../util/hashes").load(blogID);
    expect(known.get(sha1)).toBe(contentHash.slice(0, 24));
  });

  it("downloads a file without setting its mtime from client_modified", async function () {
    const beforeDownload = Date.now();

    const fakeClient = {
      filesGetMetadata: async () => ({
        result: {
          path_display: "/post.txt",
          size: 11,
        },
      }),
      filesDownload: async () => ({
        result: {
          fileBinary: Buffer.from("hello world"),
          // A client_modified far in the past used to get written to the
          // local file's mtime via setMtime; it should now be ignored.
          client_modified: "2000-01-01T00:00:00Z",
        },
      }),
    };

    await download(fakeClient, "/post.txt", blogID, destination);

    const contents = await folder.read(blogID, destination);
    expect(contents.toString()).toBe("hello world");

    const stat = await folder.stat(blogID, destination);
    expect(stat.modified).toBeGreaterThanOrEqual(beforeDownload - 1000);
  });

  it("gives up once the signal aborts, and writes nothing", async function () {
    const controller = new AbortController();
    let finish;

    const fakeClient = {
      filesDownload: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ result: { fileBinary: Buffer.from("late") } });
          controller.abort(
            Object.assign(new Error("cancelled"), { code: "ECANCELED" })
          );
        }),
    };

    let error;
    try {
      await download(fakeClient, "/post.txt", blogID, destination, {
        metadata: { path_display: "/post.txt", size: 4 },
        signal: controller.signal,
      });
    } catch (err) {
      error = err;
    }

    expect(error && error.code).toBe("ECANCELED");

    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await folder.exists(blogID, destination)).toBe(false);
  });
});
