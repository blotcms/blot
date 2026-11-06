const folder = require("storage/folder");

const download = require("../util/download");

describe("dropbox download", function () {
  const blogID = "blog_downloadtest" + Date.now();
  const destination = "/post.txt";

  afterEach(async function () {
    await folder.removeAll(blogID);
  });

  it("downloads a file without setting its mtime from client_modified", function (done) {
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

    download(fakeClient, "/post.txt", blogID, destination, async (err) => {
      try {
        expect(err).toBeFalsy();

        const contents = await folder.read(blogID, destination);
        expect(contents.toString()).toBe("hello world");

        const stat = await folder.stat(blogID, destination);
        expect(stat.modified).toBeGreaterThanOrEqual(
          beforeDownload - 1000
        );

        done();
      } catch (assertionError) {
        done(assertionError);
      }
    });
  });
});
