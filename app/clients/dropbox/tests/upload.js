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

  it("uploads without sending client_modified", async function () {
    let uploadArgs;
    const fakeClient = {
      filesUpload: async (args) => {
        uploadArgs = args;
        return { result: {} };
      },
    };

    await upload(fakeClient, source, "/post.txt");

    expect(uploadArgs.path).toBe("/post.txt");
    expect(uploadArgs.client_modified).toBeUndefined();
    expect("client_modified" in uploadArgs).toBe(false);
  });
  it("uses filesUpload for files under the threshold", async function () {
    const calls = [];
    const fakeClient = {
      filesUpload: async () => (calls.push("filesUpload"), { result: {} }),
      filesUploadSessionStart: async () => calls.push("start"),
    };

    await upload(fakeClient, source, "/post.txt");
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
        await upload(fakeClient, source, "/big.txt");
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

    it("treats incorrect_offset after a lost append response as accepted", async function () {
      const calls = [];
      let appends = 0;
      const fakeClient = {
        filesUploadSessionStart: async () => ({
          result: { session_id: "abc" },
        }),
        filesUploadSessionAppendV2: async (args) => {
          appends++;
          calls.push({ name: "append", offset: args.cursor.offset });
          if (appends === 1) {
            // Server stored the chunk, but the response was lost.
            const err = new Error("connection reset");
            err.name = "FetchError";
            err.type = "system";
            throw err;
          }
          const err = new Error("incorrect_offset");
          err.status = 409;
          err.error = {
            error: {
              ".tag": "incorrect_offset",
              correct_offset: args.cursor.offset + args.contents.length,
            },
          };
          throw err;
        },
        filesUploadSessionFinish: async (args) => {
          calls.push({ name: "finish", offset: args.cursor.offset });
          return { result: {} };
        },
      };
      const delays = require("../util/retryRequest").delays;
      const saved = delays.slice();
      delays.splice(0, delays.length, 1, 1, 1);

      try {
        await upload(fakeClient, source, "/big.txt");
      } finally {
        delays.splice(0, delays.length, ...saved);
      }

      expect(calls).toEqual([
        { name: "append", offset: 4 },
        { name: "append", offset: 4 },
        { name: "finish", offset: 8 },
      ]);
    });

    it("re-reads from the offset Dropbox reports when it differs", async function () {
      const appendOffsets = [];
      const finishes = [];
      const fakeClient = {
        filesUploadSessionStart: async () => ({
          result: { session_id: "abc" },
        }),
        filesUploadSessionAppendV2: async (args) => {
          appendOffsets.push(args.cursor.offset);
          if (appendOffsets.length === 1) {
            const err = new Error("incorrect_offset");
            err.status = 409;
            err.error = {
              error: { ".tag": "incorrect_offset", correct_offset: 2 },
            };
            throw err;
          }
        },
        filesUploadSessionFinish: async (args) => {
          finishes.push({
            offset: args.cursor.offset,
            contents: args.contents.toString(),
          });
          return { result: {} };
        },
      };

      await upload(fakeClient, source, "/big.txt");

      // hell|o wo|rld, but Dropbox only holds "he": resume from offset 2.
      expect(appendOffsets).toEqual([4, 2, 6]);
      expect(finishes).toEqual([{ offset: 10, contents: "d" }]);
    });

    it("rethrows other 409 errors", async function () {
      const fakeClient = {
        filesUploadSessionStart: async () => ({
          result: { session_id: "abc" },
        }),
        filesUploadSessionAppendV2: async () => {
          const err = new Error("not_found");
          err.status = 409;
          err.error = { error: { ".tag": "not_found" } };
          throw err;
        },
        filesUploadSessionFinish: async () => ({ result: {} }),
      };
      const error = await upload(fakeClient, source, "/big.txt").then(
        () => undefined,
        (e) => e
      );
      expect(error).toBeTruthy();
    });

    it("stops issuing requests once the upload timeout has fired", async function () {
      upload.options.timeout = 30;
      const calls = [];
      const fakeClient = {
        filesUploadSessionStart: async () => {
          calls.push("start");
          if (calls.length > 1) {
            // The retry wrapper re-runs the timed out upload: fail it fast.
            const err = new Error("unauthorized");
            err.status = 401;
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { result: { session_id: "abc" } };
        },
        filesUploadSessionAppendV2: async () => calls.push("append"),
        filesUploadSessionFinish: async () => (
          calls.push("finish"),
          { result: {} }
        ),
      };

      const error = await upload(fakeClient, source, "/big.txt").then(
        () => undefined,
        (e) => e
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(error).toBeTruthy();
      expect(calls).not.toContain("append");
      expect(calls).not.toContain("finish");
    });
  });
});
