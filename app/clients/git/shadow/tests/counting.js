// The requests figure on shadow mode's lines feeds the S3 cost estimate, so a
// store which sends several requests for one call (the S3 store's multipart
// put and paged list) counts each one it sends
describe("git store shadow mode: counting requests", function () {
  var counting = require("clients/git/shadow/counting");
  var { createS3Store, createMemoryStore } = require("clients/git/store");

  var MiB = 1024 * 1024;

  // An S3 client which answers just enough for a multipart put and a list of
  // two pages, and counts what it is sent
  function fakeClient() {
    var client = { sends: 0 };

    client.send = async function (command) {
      client.sends++;

      switch (command.constructor.name) {
        case "CreateMultipartUploadCommand":
          return { UploadId: "upload" };
        case "UploadPartCommand":
          return { ETag: '"part' + command.input.PartNumber + '"' };
        case "CompleteMultipartUploadCommand":
          return {};
        case "ListObjectsV2Command":
          if (!command.input.ContinuationToken) {
            return { Contents: [{ Key: "p/a", Size: 1 }], IsTruncated: true, NextContinuationToken: "next" };
          }
          return { Contents: [{ Key: "p/b", Size: 1 }], IsTruncated: false };
        default:
          throw new Error("Unexpected " + command.constructor.name);
      }
    };

    return client;
  }

  // As shadow/index.js makes its S3 store
  function s3Store(client) {
    var store = createS3Store({
      client: {
        send: function (command) {
          counting.sent();
          return client.send(command);
        },
      },
      bucket: "bucket",
      prefix: "p/",
      partSize: 5 * MiB,
    });

    return counting(Object.assign(store, { countsOwnRequests: true }));
  }

  it("counts each request of a multipart put", async function () {
    var client = fakeClient();
    var store = s3Store(client);

    var measured = await counting.measure(function () {
      return store.put("packs/big.pack", Buffer.alloc(12 * MiB));
    });

    // Create, three parts and complete
    expect(client.sends).toBe(5);
    expect(measured.counts.requests).toBe(5);
    expect(measured.counts.bytesUp).toBe(12 * MiB);
  });

  it("counts each page of a list", async function () {
    var client = fakeClient();
    var store = s3Store(client);

    var measured = await counting.measure(async function () {
      var keys = [];
      for await (var entry of store.list("")) keys.push(entry.key);
      return keys;
    });

    expect(measured.result).toEqual(["a", "b"]);
    expect(measured.counts.requests).toBe(2);
  });

  it("counts a call as one request for a store which doesn't count its own", async function () {
    var store = counting(createMemoryStore());

    var measured = await counting.measure(async function () {
      await store.put("a", Buffer.from("A"));
      await store.get("a");
    });

    expect(measured.counts.requests).toBe(2);
  });
});
