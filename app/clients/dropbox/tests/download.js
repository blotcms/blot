const folder = require("storage/folder");

const download = require("../util/download");

describe("dropbox download", function () {
  const blogID = "blog_downloadtest" + Date.now();
  const destination = "/post.txt";

  afterEach(async function () {
    await folder.removeAll(blogID);
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
