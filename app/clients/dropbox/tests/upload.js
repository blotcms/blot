const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const upload = require("../util/upload");

describe("dropbox upload", function () {
  let source;

  beforeEach(async function () {
    source = path.join(
      os.tmpdir(),
      `dropbox-upload-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    );
    await fs.outputFile(source, "hello world");
  });

  afterEach(async function () {
    await fs.remove(source);
  });

  it("uploads without sending client_modified", function (done) {
    let uploadArgs;
    const fakeClient = {
      filesUpload: async (args) => {
        uploadArgs = args;
        return { result: {} };
      },
    };

    upload(fakeClient, source, "/post.txt", (err) => {
      try {
        expect(err).toBeFalsy();
        expect(uploadArgs.path).toBe("/post.txt");
        expect(uploadArgs.client_modified).toBeUndefined();
        expect("client_modified" in uploadArgs).toBe(false);
        done();
      } catch (assertionError) {
        done(assertionError);
      }
    });
  });
});
