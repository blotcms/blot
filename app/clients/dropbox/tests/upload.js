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
  it("uses filesUpload for files under the threshold", async function () {
    const calls = [];
    const fakeClient = {
      filesUpload: async () => (calls.push("filesUpload"), { result: {} }),
      filesUploadSessionStart: async () => calls.push("start"),
    };

    await new Promise((resolve, reject) =>
      upload(fakeClient, source, "/post.txt", (e) => (e ? reject(e) : resolve()))
    );
    expect(calls).toEqual(["filesUpload"]);
  });

  describe("large files", function () {
    const original = { ...upload.options };

    beforeEach(function () {
      upload.options.threshold = 10;
      upload.options.chunkSize = 4;
    });

    afterEach(function () {
      Object.assign(upload.options, original);
    });

    it("uses the upload session API in order with correct offsets", async function () {
      const calls = [];
      const fakeClient = {
        filesUpload: async () => calls.push({ name: "filesUpload" }),
        filesUploadSessionStart: async (args) => {
          calls.push({ name: "start", args });
          return { result: { session_id: "abc" } };
        },
        filesUploadSessionAppendV2: async (args) => {
          calls.push({ name: "append", args });
        },
        filesUploadSessionFinish: async (args) => {
          calls.push({ name: "finish", args });
          return { result: {} };
        },
      };
      let failed = false;
      const append = fakeClient.filesUploadSessionAppendV2;
      fakeClient.filesUploadSessionAppendV2 = async (args) => {
        if (!failed) {
          failed = true;
          const err = new Error("boom");
          err.status = 503;
          throw err;
        }
        return append(args);
      };
      const delays = require("../util/retryRequest").delays;
      const saved = delays.slice();
      delays.splice(0, delays.length, 1, 1, 1);

      try {
        await new Promise((resolve, reject) =>
          upload(fakeClient, source, "/big.txt", (e) =>
            e ? reject(e) : resolve()
          )
        );
      } finally {
        delays.splice(0, delays.length, ...saved);
      }

      // "hello world" = 11 bytes, chunks of 4: hell | o wo | rld
      expect(calls.map((c) => c.name)).toEqual(["start", "append", "finish"]);
      expect(calls[0].args.contents.toString()).toBe("hell");
      expect(calls[1].args.cursor).toEqual({ session_id: "abc", offset: 4 });
      expect(calls[1].args.contents.toString()).toBe("o wo");
      expect(calls[2].args.cursor).toEqual({ session_id: "abc", offset: 8 });
      expect(calls[2].args.contents.toString()).toBe("rld");
      expect(calls[2].args.commit).toEqual({
        path: "/big.txt",
        mode: { ".tag": "overwrite" },
        autorename: false,
      });
      expect("client_modified" in calls[2].args.commit).toBe(false);
    });
  });
});
