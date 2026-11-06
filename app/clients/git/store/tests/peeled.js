// Annotated tags in the manifest: the peeled target recorded when a tag is
// pushed, advertised as git's "^{}" line, and carried or dropped as snapshots
// come and go.
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const manifest = require("../manifest");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { advertise } = require("../advertise");
const { split } = require("../pktline");

const MiB = 1024 * 1024;

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

describe("git store peeled tags", function () {
  timeout(60 * 1000);

  let dir;
  let work;
  let store;
  let received;

  beforeEach(async function () {
    dir = fx.tempDir();
    work = path.join(dir, "work");
    fx.buildFixture(work, { commits: 3, large: false });
    store = createMemoryStore();
    const cache = createCache({
      dir: path.join(dir, "cache"),
      maxBytes: 64 * MiB,
    });
    received = await createReceiveServer({ store, cache, lock: createLock() });
  });

  afterEach(async function () {
    await received.close();
    fx.remove(dir);
  });

  it("records the target of an annotated tag when it is pushed, and advertises it", async function () {
    fx.git(work, ["tag", "light", "master~1"]);
    fx.git(work, ["tag", "-a", "nested", "-m", "A tag of a tag", "v1"]);
    const target = fx.text(work, ["rev-parse", "master"]);
    expect(
      (
        await push(work, [
          received.url,
          "master",
          "refs/tags/v1",
          "refs/tags/light",
          "refs/tags/nested",
        ])
      ).code
    ).toBe(0);

    const current = await manifest.read(store);
    const v1 = current.refs["refs/tags/v1"];
    expect(current.peeled).toEqual({
      [v1]: target,
      [current.refs["refs/tags/nested"]]: target,
    });

    const lines = split(advertise(current))
      .filter((p) => p.data)
      .map((p) => p.data.toString("latin1").split("\0")[0]);
    expect(lines).toContain(target + " refs/tags/v1^{}");
    expect(lines).toContain(target + " refs/tags/nested^{}");
    expect(lines.filter((l) => l.endsWith("^{}")).length).toBe(2);
    expect(lines.indexOf(target + " refs/tags/v1^{}")).toBe(
      lines.indexOf(v1 + " refs/tags/v1") + 1
    );
  });

  it("peels a tag whose object is already in the repository", async function () {
    const target = fx.text(work, ["rev-parse", "master"]);
    expect(
      (await push(work, [received.url, "master", "refs/tags/v1"])).code
    ).toBe(0);

    // The same tag object under another name: the push carries no objects
    expect(
      (await push(work, [received.url, "refs/tags/v1:refs/tags/again"])).code
    ).toBe(0);
    const current = await manifest.read(store);
    expect(current.refs["refs/tags/again"]).toBe(current.refs["refs/tags/v1"]);
    expect(Object.values(current.peeled)).toEqual([target]);
  });

  it("peels a tag at a stored object bigger than the reader will hold, reading only the tag", async function () {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(65 * MiB));
    const blob = fx.text(work, ["hash-object", "-w", big]);
    fs.rmSync(big);

    // The blob goes in under a plain tag; the annotated tag then comes with no blob
    fx.git(work, ["tag", "plain", blob]);
    expect(
      (await push(work, [received.url, "master", "refs/tags/plain"])).code
    ).toBe(0);
    fx.git(work, ["tag", "-a", "annotated", "-m", "A tag of a big file", blob]);
    const pushed = await push(work, [received.url, "refs/tags/annotated"]);
    expect(pushed.code).toBe(0);

    const current = await manifest.read(store);
    expect(current.peeled).toEqual({
      [current.refs["refs/tags/annotated"]]: blob,
    });
  });

  it("forgets the target of a tag once no snapshot names it, and keeps the field valid", function () {
    const tag = "a".repeat(40);
    const commit = "b".repeat(40);
    const base = manifest.advance(manifest.empty(), {
      refs: { "refs/tags/t": tag },
      peeled: { [tag]: commit },
    });
    expect(base.peeled).toEqual({ [tag]: commit });

    // The tag is deleted, but a snapshot still names it
    const next = manifest.advance(base, { refs: {} });
    expect(next.peeled).toEqual({ [tag]: commit });
    expect(manifest.parse(manifest.serialize(next)).peeled).toEqual({
      [tag]: commit,
    });

    // Without the snapshots, nothing does
    const trimmed = manifest.advance({ ...next, snapshots: [] }, { refs: {} });
    expect(trimmed.peeled).toEqual({});
  });

  it("does not add the field to a manifest which has refs and never had it", function () {
    const legacy = {
      ...manifest.empty(),
      seq: 1,
      writer: "w",
      refs: { "refs/heads/master": "c".repeat(40) },
      snapshots: [{ seq: 1, refs: { "refs/heads/master": "c".repeat(40) } }],
    };
    const next = manifest.advance(legacy, {
      refs: legacy.refs,
      peeled: { ["d".repeat(40)]: "e".repeat(40) },
    });
    expect("peeled" in next).toBe(false);
  });

  it("refuses a peeled field which is not a map of object IDs", function () {
    const base = manifest.empty();
    for (const bad of [
      [],
      "x",
      { nope: "a".repeat(40) },
      { ["a".repeat(40)]: "short" },
      null,
    ]) {
      expect(() => manifest.validate({ ...base, peeled: bad })).toThrow();
    }
    expect(() => manifest.validate({ ...base, peeled: {} })).not.toThrow();
  });
});
