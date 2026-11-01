// What every object store implementation has to do, as a list of
// [name, async (store) => {...}] cases which use jasmine's expect. Not a spec
// itself: tests/objectStore.js runs the cases on the in-memory store and
// tests/s3.js on S3, each making a fresh empty store for every case.
const crypto = require("crypto");
const { Readable } = require("stream");
const { NotFoundError, TooLargeError } = require("../../errors");

const MIB = 1024 * 1024;
const sha = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

async function toBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fails(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

async function listAll(store, prefix) {
  const out = [];
  for await (const item of store.list(prefix)) out.push(item);
  return out;
}

async function* chunked(buffer, size) {
  for (let at = 0; at < buffer.length; at += size) yield buffer.subarray(at, at + size);
}

module.exports = [
  [
    "has an id",
    async (store) => {
      expect(typeof store.id).toBe("string");
      expect(store.id.length).toBeGreaterThan(0);
    },
  ],
  [
    "puts and gets a buffer",
    async (store) => {
      await store.put("a/b.txt", Buffer.from("hello"));
      expect((await store.get("a/b.txt")).toString()).toBe("hello");
    },
  ],
  [
    "puts an empty object",
    async (store) => {
      await store.put("empty", Buffer.alloc(0));
      expect((await store.get("empty")).length).toBe(0);
      expect(await store.head("empty")).toEqual({ size: 0 });
    },
  ],
  [
    "replaces an object",
    async (store) => {
      await store.put("k", Buffer.from("one"));
      await store.put("k", Buffer.from("two!"));
      expect((await store.get("k")).toString()).toBe("two!");
    },
  ],
  [
    "says how big an object is, or that it isn't there",
    async (store) => {
      await store.put("k", Buffer.from("12345"));
      expect(await store.head("k")).toEqual({ size: 5 });
      expect(await store.head("nope")).toBeNull();
    },
  ],
  [
    "throws NotFoundError for a missing key",
    async (store) => {
      expect(await fails(store.get("nope"))).toEqual(jasmine.any(NotFoundError));
      expect(await fails(store.read("nope", 0, 10))).toEqual(jasmine.any(NotFoundError));
      expect(await fails(toBuffer(store.stream("nope")))).toEqual(jasmine.any(NotFoundError));
    },
  ],
  [
    "refuses to get an object over maxBytes",
    async (store) => {
      await store.put("k", Buffer.alloc(100));
      expect(await fails(store.get("k", { maxBytes: 99 }))).toEqual(jasmine.any(TooLargeError));
      expect((await store.get("k", { maxBytes: 100 })).length).toBe(100);
    },
  ],
  [
    "reads a range",
    async (store) => {
      await store.put("k", Buffer.from("0123456789"));
      expect((await store.read("k", 2, 4)).toString()).toBe("2345");
      expect((await store.read("k", 0, 1)).toString()).toBe("0");
      expect((await store.read("k", 9, 1)).toString()).toBe("9");
    },
  ],
  [
    "returns what there is for a range which runs past the end",
    async (store) => {
      await store.put("k", Buffer.from("0123456789"));
      expect((await store.read("k", 7, 100)).toString()).toBe("789");
    },
  ],
  [
    "returns nothing for a range which starts at or past the end",
    async (store) => {
      await store.put("k", Buffer.from("0123456789"));
      expect((await store.read("k", 10, 5)).length).toBe(0);
      expect((await store.read("k", 500, 5)).length).toBe(0);
    },
  ],
  [
    "returns nothing for an empty range",
    async (store) => {
      await store.put("k", Buffer.from("0123456789"));
      expect((await store.read("k", 3, 0)).length).toBe(0);
    },
  ],
  [
    "streams all of an object, or a range of it",
    async (store) => {
      await store.put("k", Buffer.from("0123456789"));
      expect((await toBuffer(store.stream("k"))).toString()).toBe("0123456789");
      expect((await toBuffer(store.stream("k", 3, 4))).toString()).toBe("3456");
      expect((await toBuffer(store.stream("k", 8))).toString()).toBe("89");
    },
  ],
  [
    "puts a small stream",
    async (store) => {
      await store.put("s", Readable.from([Buffer.from("ab"), Buffer.from("cd")], { objectMode: false }));
      expect((await store.get("s")).toString()).toBe("abcd");
    },
  ],
  [
    "puts an empty stream",
    async (store) => {
      await store.put("s", chunked(Buffer.alloc(0), 10));
      expect((await store.get("s")).length).toBe(0);
    },
  ],
  [
    "puts a stream of several megabytes in odd-sized chunks",
    async (store) => {
      const data = crypto.randomBytes(13 * MIB + 123);
      await store.put("big", chunked(data, 1000003));
      expect(await store.head("big")).toEqual({ size: data.length });
      expect(sha(await toBuffer(store.stream("big")))).toBe(sha(data));

      const at = 5 * MIB - 7;
      expect((await store.read("big", at, 100)).equals(data.subarray(at, at + 100))).toBe(true);
    },
  ],
  [
    "puts a stream which is exactly a whole number of parts",
    async (store) => {
      const data = crypto.randomBytes(10 * MIB);
      await store.put("exact", chunked(data, MIB));
      expect(sha(await store.get("exact"))).toBe(sha(data));
    },
  ],
  [
    "leaves nothing behind when the stream fails",
    async (store) => {
      async function* broken() {
        yield crypto.randomBytes(6 * MIB);
        yield crypto.randomBytes(6 * MIB);
        throw new Error("the source broke");
      }
      const error = await fails(store.put("broken", broken()));
      expect(error && error.message).toBe("the source broke");
      expect(await store.head("broken")).toBeNull();
    },
  ],
  [
    "creates an object only if it is absent",
    async (store) => {
      expect(await store.putIfAbsent("m/1.json", Buffer.from("one"))).toBe(true);
      expect((await store.get("m/1.json")).toString()).toBe("one");

      expect(await store.putIfAbsent("m/1.json", Buffer.from("two!"))).toBe(false);
      expect((await store.get("m/1.json")).toString()).toBe("one");

      await store.put("m/2.json", Buffer.from("put"));
      expect(await store.putIfAbsent("m/2.json", Buffer.from("again"))).toBe(false);
      expect((await store.get("m/2.json")).toString()).toBe("put");
    },
  ],
  [
    "creates an empty object if it is absent",
    async (store) => {
      expect(await store.putIfAbsent("empty", Buffer.alloc(0))).toBe(true);
      expect(await store.head("empty")).toEqual({ size: 0 });
      expect(await store.putIfAbsent("empty", Buffer.from("x"))).toBe(false);
    },
  ],
  [
    "lets exactly one of several racing writers create an object",
    async (store) => {
      const bodies = Array.from({ length: 8 }, (_, i) => Buffer.from("writer " + i));
      const results = await Promise.all(bodies.map((body) => store.putIfAbsent("race", body)));

      expect(results.filter(Boolean).length).toBe(1);
      expect((await store.get("race")).equals(bodies[results.indexOf(true)])).toBe(true);
    },
  ],
  [
    "deletes an object, and doesn't mind if it's gone",
    async (store) => {
      await store.put("k", Buffer.from("x"));
      await store.delete("k");
      expect(await store.head("k")).toBeNull();
      await store.delete("k");
      await store.delete("never-existed");
    },
  ],
  [
    "lists keys under a prefix, with sizes, relative to the store",
    async (store) => {
      await store.put("packs/a.pack", Buffer.alloc(3));
      await store.put("packs/a.idx", Buffer.alloc(2));
      await store.put("manifest.json", Buffer.alloc(1));

      const packs = await listAll(store, "packs/");
      expect(packs.map((i) => i.key).sort()).toEqual(["packs/a.idx", "packs/a.pack"]);
      expect(packs.find((i) => i.key === "packs/a.pack").size).toBe(3);
      expect((await listAll(store, "")).length).toBe(3);
      expect(await listAll(store, "nothing/")).toEqual([]);
    },
  ],
];
