// write() puts a file on Dropbox before it puts it in Blot's folder: a process
// killed between the two must leave a file Dropbox has (which the next sync
// downloads), never one only Blot has (which the next walk deletes)
describe("dropbox write order", function () {
  const loadClientPath = require.resolve("clients/dropbox/util/loadClient");
  const uploadPath = require.resolve("clients/dropbox/util/upload");
  const writePath = require.resolve("clients/dropbox/write");
  const folder = require("storage/folder");
  const fs = require("fs-extra");
  const paths = [loadClientPath, uploadPath, writePath];
  const originals = {};

  let events, write;

  beforeEach(function () {
    events = [];
    paths.forEach((path) => (originals[path] = require.cache[path]));

    require.cache[loadClientPath] = {
      exports: async () => ({
        client: {},
        account: { folder: "/Site", error_code: 0 },
      }),
    };
    require.cache[uploadPath] = {
      exports: async (client, source, destination) => {
        events.push([
          "upload",
          destination,
          (await fs.readFile(source)).toString(),
        ]);
      },
    };
    delete require.cache[writePath];
    write = require("clients/dropbox/write");

    spyOn(folder, "write").and.callFake(async (blogID, path) => {
      events.push(["local", path]);
    });
  });

  afterEach(function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
  });

  it("uploads to Dropbox before writing the file to Blot's folder", async function () {
    await write("blog_order", "/post.txt", "Hello");
    expect(events).toEqual([
      ["upload", "/Site/post.txt", "Hello"],
      ["local", "/post.txt"],
    ]);
  });

  it("leaves Blot's folder alone when the upload fails", async function () {
    delete require.cache[writePath];
    require.cache[uploadPath] = {
      exports: async () => {
        // A 409 isn't retried, so the spec doesn't wait out the backoff
        const err = new Error("path/conflict");
        err.status = 409;
        throw err;
      },
    };
    write = require("clients/dropbox/write");

    await expectAsync(write("blog_order", "/post.txt", "Hello")).toBeRejected();
    expect(events).toEqual([]);
  });
});
