const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const download = require("../util/download");

describe("dropbox download", function () {
  let destination;

  beforeEach(async function () {
    destination = path.join(
      os.tmpdir(),
      `dropbox-download-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    );
  });

  afterEach(async function () {
    await fs.remove(destination);
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

    download(fakeClient, "/post.txt", destination, async (err) => {
      try {
        expect(err).toBeFalsy();

        const contents = await fs.readFile(destination);
        expect(contents.toString()).toBe("hello world");

        const stat = await fs.stat(destination);
        expect(stat.mtime.getTime()).toBeGreaterThanOrEqual(
          beforeDownload - 1000
        );

        done();
      } catch (assertionError) {
        done(assertionError);
      }
    });
  });
});
