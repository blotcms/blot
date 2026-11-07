describe("git store: removing a blog's repository", function () {
  // A blog on the git client with a clone, a memory store per blog, and the
  // store's log lines kept
  require("clients/git/tests/setup")({
    clone: false,
    client: true,
    lines: true,
  });

  var removal = require("clients/git/served/remove");
  var disconnect = require("clients/git/disconnect");
  var { manifest } = require("clients/git/store");

  function disconnected(blogID) {
    return disconnect(blogID);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function keys(store) {
    var found = [];
    for await (var entry of store.list("")) found.push(entry.key);
    return found;
  }

  // What a removal leaves is the manifests (the newest a tombstone), so the
  // numbering never starts again at 1; everything else goes
  async function packsLeft(store) {
    return (await keys(store)).filter(function (key) {
      return !key.startsWith("manifests/");
    });
  }

  // A store object of its own, so nothing it remembers is read back
  function fresh(store) {
    return Object.assign({}, store, { id: store.id });
  }

  var PACK = "packs/pack-" + "a".repeat(40) + ".pack";

  afterEach(function () {
    removal._setRemoveAgainMs(5 * 60 * 1000);
  });

  it("deletes everything under the blog's prefix but the manifests on disconnect, and leaves a tombstone", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.writeAndPush("/b.txt", "B");

    var store = this.stores[this.blog.id];
    var before = await manifest.read(store);
    expect((await packsLeft(store)).length).toBeGreaterThan(0);

    await disconnected(this.blog.id);

    expect(await packsLeft(store)).toEqual([]);
    var tombstone = await manifest.read(fresh(store));
    expect(tombstone.seq).toBe(before.seq + 1);
    expect(manifest.isEmpty(tombstone)).toBe(true);
    expect(this.storeLines("remove")[0]).toContain("outcome=ok");
  });

  it("deletes the copy again later, for work another process had started", async function () {
    removal._setRemoveAgainMs(100);

    await this.local.writeAndPush("/a.txt", "A");

    var store = this.stores[this.blog.id];

    await disconnected(this.blog.id);

    // What another process's push, already running, uploads afterwards
    await store.put(PACK, Buffer.from("x"));

    await sleep(1000);

    expect(await packsLeft(store)).toEqual([]);
  });

  it("keeps the copy when the blog is back on git by the second pass", async function () {
    removal._setRemoveAgainMs(100);

    await this.local.writeAndPush("/a.txt", "A");

    var store = this.stores[this.blog.id];

    await disconnected(this.blog.id);

    // Reconnected, and set up again
    await require("models/blog").set(this.blog.id, { client: "git" });
    await store.put(PACK, Buffer.from("x"));

    await sleep(1000);

    expect(await packsLeft(store)).toEqual([PACK]);
  });

  it("keeps the copy when the later lookup of the blog fails", async function () {
    removal._setRemoveAgainMs(100);

    await this.local.writeAndPush("/a.txt", "A");

    var store = this.stores[this.blog.id];
    var Blog = require("models/blog");
    var get = Blog.get;

    await disconnected(this.blog.id);

    // Reconnected, and imported by another process, but Redis fails the lookup
    await store.put(PACK, Buffer.from("x"));
    Blog.get = async function () {
      throw new Error("Redis went away");
    };

    try {
      await sleep(1000);
    } finally {
      Blog.get = get;
    }

    expect(await packsLeft(store)).toEqual([PACK]);
    expect(
      this.storeLines("remove").filter((line) =>
        / outcome=spared .*pass=2/.test(line)
      ).length
    ).toBe(1);
  });
});
