// The S3 object store, against the MinIO the test runner starts
// (.github/actions/start-minio in CI, scripts/tests/invoke.sh locally), which
// supports the same S3 subset as Backblaze B2. Each run makes a bucket of its
// own. Without MinIO's settings in the environment the specs are skipped, and
// say so in the output.
const crypto = require("crypto");
const { Readable } = require("stream");
const fx = require("./helpers/fixture");
const cases = require("./helpers/contract");
const timeout = require("./helpers/timeout");
const createReader = require("../reader");
const createCache = require("../cache");
const manifest = require("../manifest");
const { readRanges } = require("../ranges");

const endpoint = process.env.BLOT_STORAGE_ENDPOINT;
const MIB = 1024 * 1024;

(endpoint ? describe : xdescribe)("git store S3 object store (needs MinIO)", function () {
  timeout(120 * 1000);

  const sdk = endpoint ? require("@aws-sdk/client-s3") : null;
  const bucket = "git-store-" + crypto.randomBytes(6).toString("hex");
  let client;

  // A client which counts the bytes of every part uploaded, and calls
  const sent = { parts: 0, partBytes: 0, calls: [] };

  function makeClient() {
    const real = new sdk.S3Client({
      region: process.env.BLOT_STORAGE_REGION || "us-east-1",
      endpoint,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: process.env.BLOT_AWS_KEY,
        secretAccessKey: process.env.BLOT_AWS_SECRET,
      },
    });
    const send = real.send.bind(real);
    real.send = async (command) => {
      sent.calls.push(command.constructor.name);
      const out = await send(command);
      if (command instanceof sdk.UploadPartCommand) {
        sent.parts++;
        sent.partBytes += command.input.Body.length;
      }
      return out;
    };
    return real;
  }

  beforeAll(async function () {
    client = makeClient();
    await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async function () {
    for (let token; ; ) {
      const out = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const item of out.Contents || []) await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
      token = out.NextContinuationToken;
      if (!token) break;
    }
    await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  function newStore(options = {}) {
    return require("../objectStore/s3")({
      client,
      bucket,
      prefix: "git/blog_" + crypto.randomBytes(6).toString("hex") + "/",
      partSize: 5 * MIB,
      partConcurrency: 2,
      ...options,
    });
  }

  describe("the object store interface", function () {
    for (const [name, run] of cases) {
      it(name, async function () {
        await run(newStore());
      });
    }
  });

  it("keeps each repository under its own prefix", async function () {
    const a = newStore();
    const b = newStore();
    await a.put("manifest.json", Buffer.from("a"));
    await b.put("manifest.json", Buffer.from("b"));

    expect((await a.get("manifest.json")).toString()).toBe("a");
    expect((await b.get("manifest.json")).toString()).toBe("b");
    expect(a.id).not.toBe(b.id);

    const keys = [];
    for await (const item of a.list("")) keys.push(item.key);
    expect(keys).toEqual(["manifest.json"]);
  });

  describe("conditional create", function () {
    it("sends If-None-Match: * and MinIO enforces it", async function () {
      const store = newStore();
      const before = sent.calls.length;
      expect(await store.putIfAbsent("manifests/0000000001.json", Buffer.from("first"))).toBe(true);
      expect(await store.putIfAbsent("manifests/0000000001.json", Buffer.from("second"))).toBe(false);
      expect(sent.calls.slice(before)).toEqual(["PutObjectCommand", "PutObjectCommand"]);
      expect((await store.get("manifests/0000000001.json")).toString()).toBe("first");
    });

    it("lets only one of two swaps from the same base win, with no lock to help", async function () {
      const store = newStore();
      const none = (fn) => fn();
      const pack = (n) => {
        const name = "pack-" + String(n).repeat(40);
        return { name, size: 100, idxSize: 50, objects: 1 };
      };
      const first = manifest.advance(manifest.empty(), { refs: {}, packs: [pack(1)] });
      for (const entry of first.packs) {
        await store.put("packs/" + entry.name + ".pack", Buffer.alloc(entry.size));
        await store.put("packs/" + entry.name + ".idx", Buffer.alloc(entry.idxSize));
      }
      await manifest.swap({ store, lock: none, base: manifest.empty(), next: first });

      const rivals = [2, 3, 4, 5].map((n) => manifest.advance(first, { refs: { "refs/heads/master": String(n).repeat(40) }, head: "refs/heads/master" }));
      const results = await Promise.all(rivals.map((next) => manifest.swap({ store, lock: none, base: first, next }).then(() => null, (err) => err)));

      expect(results.filter((r) => !r).length).toBe(1);
      for (const err of results.filter(Boolean)) expect(err.code).toBe("STALE_MANIFEST");
      const winner = rivals[results.findIndex((r) => !r)];
      expect(await manifest.read(store)).toEqual(winner);
    });
  });

  it("uploads a large stream in parts without reading far ahead of what has been sent", async function () {
    const store = newStore();
    const total = 40 * MIB;
    const chunk = crypto.randomBytes(MIB);
    let produced = 0;
    let worstLead = 0;
    const before = { parts: sent.parts, bytes: sent.partBytes };

    async function* source() {
      while (produced < total) {
        produced += chunk.length;
        worstLead = Math.max(worstLead, produced - (sent.partBytes - before.bytes));
        yield chunk;
      }
    }

    await store.put("big.pack", source());

    // partSize 5 MiB with two uploads at a time: the source may be ahead by the
    // parts in flight, one being cut, and one just read, never a stream's worth
    expect(worstLead).toBeLessThanOrEqual(5 * MIB * 4 + 2 * MIB);
    expect(sent.parts - before.parts).toBe(8);
    expect(await store.head("big.pack")).toEqual({ size: total });
    expect((await store.read("big.pack", 7 * MIB + 3, 10)).equals(chunk.subarray(3, 13))).toBe(true);
  });

  it("aborts a multipart upload which fails, leaving nothing", async function () {
    const store = newStore();
    async function* broken() {
      yield crypto.randomBytes(6 * MIB);
      yield crypto.randomBytes(6 * MIB);
      throw new Error("the source broke");
    }

    await store.put("x", broken()).catch(() => {});
    expect(sent.calls).toContain("AbortMultipartUploadCommand");

    const uploads = await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket, Prefix: store.id.split("/").slice(1).join("/") }));
    expect(uploads.Uploads || []).toEqual([]);
  });

  describe("a repository read by range", function () {
    let workDir;
    let fixture;
    let store;
    let reader;
    let oracle;

    beforeAll(async function () {
      workDir = fx.tempDir();
      fixture = fx.buildFixture(workDir + "/repo", { commits: 14, large: true });
      fx.repackAll(fixture.dir);
      oracle = fx.catAll(fixture.dir);

      store = newStore();
      const [pack] = fx.readPacks(fixture.dir);
      const entry = await fx.upload(store, pack, oracle.size);
      await manifest.swap({
        store,
        lock: (fn) => fn(),
        base: manifest.empty(),
        next: manifest.advance(manifest.empty(), { refs: { "refs/heads/master": fixture.head }, packs: [entry] }),
      });

      reader = createReader({ store, cache: createCache({ dir: workDir + "/cache", maxBytes: 4 * MIB }), packs: (await manifest.read(store)).packs });
    });

    afterAll(function () {
      fx.remove(workDir);
    });

    it("reads the manifest back", async function () {
      const m = await manifest.read(store);
      expect(m.refs["refs/heads/master"]).toBe(fixture.head);
      expect(m.packs.length).toBe(1);
    });

    it("reads every object as git does", async function () {
      for (const [oid, want] of oracle) {
        const got = await reader.read(oid);
        if (!got || got.type !== want.type || !got.data.equals(want.data)) fail("Object " + oid + " differs from git cat-file");
      }
    });

    it("streams a large object", async function () {
      const [oid, want] = [...oracle].find(([, o]) => o.data.length === 3 * MIB);
      const got = await reader.stream(oid);
      const chunks = [];
      for await (const chunk of got.data) chunks.push(chunk);
      expect(Buffer.concat(chunks).equals(want.data)).toBe(true);
    });

    it("reads ranges of a pack, merged", async function () {
      const key = "packs/" + (await manifest.read(store)).packs[0].name + ".pack";
      const before = sent.calls.length;
      const got = await readRanges(store, key, [{ offset: 0, length: 12 }, { offset: 100, length: 50 }, { offset: 40, length: 10 }]);
      expect(got[0].subarray(0, 4).toString()).toBe("PACK");
      expect(got.map((b) => b.length)).toEqual([12, 50, 10]);
      expect(sent.calls.length - before).toBe(1);
    });
  });
});

// putIfAbsent's handling of S3's answers, against a client which gives them, so
// it needs no MinIO (MinIO can't be made to answer 409 on demand)
const hasSdk = (function () {
  try {
    require.resolve("@aws-sdk/client-s3");
    return true;
  } catch (err) {
    return false;
  }
})();

(hasSdk ? describe : xdescribe)("git store S3 putIfAbsent answers", function () {
  function answer(status, name) {
    const err = new Error(name);
    err.name = name;
    err.$metadata = { httpStatusCode: status };
    return err;
  }

  // A store whose client replies to each PutObject with the next of `replies`
  // (an error to throw, or anything else to succeed with)
  function storeReplying(...replies) {
    const sentInputs = [];
    const client = {
      send: async (command) => {
        sentInputs.push(command.input);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return {};
      },
    };
    const store = require("../objectStore/s3")({ client, bucket: "b", prefix: "p/", conflictDelay: 0 });
    return { store, sentInputs };
  }

  const body = Buffer.from("{}");
  const conflict = () => answer(409, "ConditionalRequestConflict");

  // A store whose client answers each command by its class name from
  // `handlers` (a function, called with the command's input), and otherwise
  // with an empty reply, noting every command sent
  function storeHandling(handlers = {}) {
    const calls = [];
    const client = {
      send: async (command) => {
        const name = command.constructor.name;
        calls.push({ name, input: command.input });
        return handlers[name] ? handlers[name](command.input) : {};
      },
    };
    const store = require("../objectStore/s3")({ client, bucket: "b", prefix: "p/", conflictDelay: 0, partSize: 5 * 1024 * 1024, partConcurrency: 2 });
    return { store, calls };
  }

  it("uploads a Buffer larger than a part in parts", async function () {
    const { store, calls } = storeHandling({
      CreateMultipartUploadCommand: () => ({ UploadId: "u" }),
      UploadPartCommand: (input) => ({ ETag: "e" + input.PartNumber }),
    });
    await store.put("big", Buffer.alloc(11 * 1024 * 1024));

    const parts = calls.filter((c) => c.name === "UploadPartCommand");
    expect(parts.map((c) => c.input.Body.length)).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 1024 * 1024]);
    expect(calls[calls.length - 1].name).toBe("CompleteMultipartUploadCommand");
  });

  it("creates the key with If-None-Match: *", async function () {
    const { store, sentInputs } = storeReplying(null);
    expect(await store.putIfAbsent("k", body)).toBe(true);
    expect(sentInputs.length).toBe(1);
    expect(sentInputs[0]).toEqual(jasmine.objectContaining({ Bucket: "b", Key: "p/k", IfNoneMatch: "*" }));
  });

  it("is false on a 412", async function () {
    const { store, sentInputs } = storeReplying(answer(412, "PreconditionFailed"));
    expect(await store.putIfAbsent("k", body)).toBe(false);
    expect(sentInputs.length).toBe(1);
  });

  it("tries again on a 409, and succeeds", async function () {
    const { store, sentInputs } = storeReplying(conflict(), conflict(), null);
    expect(await store.putIfAbsent("k", body)).toBe(true);
    expect(sentInputs.length).toBe(3);
  });

  it("is false when a retry after a 409 finds the key there", async function () {
    const { store } = storeReplying(conflict(), answer(412, "PreconditionFailed"));
    expect(await store.putIfAbsent("k", body)).toBe(false);
  });

  it("throws if it still gets 409 after a few tries", async function () {
    const { store, sentInputs } = storeReplying(conflict(), conflict(), conflict(), conflict(), conflict());
    let error;
    await store.putIfAbsent("k", body).catch((err) => (error = err));
    expect(error && error.$metadata.httpStatusCode).toBe(409);
    expect(sentInputs.length).toBeLessThan(6);
    expect(sentInputs.length).toBeGreaterThan(1);
  });

  it("passes on any other error without trying again", async function () {
    const { store, sentInputs } = storeReplying(answer(500, "InternalError"), null);
    let error;
    await store.putIfAbsent("k", body).catch((err) => (error = err));
    expect(error && error.name).toBe("InternalError");
    expect(sentInputs.length).toBe(1);
  });
});
