describe("git store shadow mode: removing a blog's copy", function () {
  var setup = require("./setup");
  var shadow = require("clients/git/shadow");
  var config = require("config");
  var disconnect = require("clients/git/disconnect");
  var { createMemoryStore, manifest } = require("clients/git/store");

  function disconnected(blogID) {
    return new Promise(function (resolve, reject) {
      disconnect(blogID, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
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

  // What a removal leaves is the manifests (the newest a tombstone) and the
  // hint, so the numbering never starts again at 1; everything else goes
  async function packsLeft(store) {
    return (await keys(store)).filter(function (key) {
      return !key.startsWith("manifests/");
    });
  }

  var PACK = "packs/pack-" + "a".repeat(40) + ".pack";

  describe("with a memory store", function () {
    setup();

    afterEach(function () {
      shadow._setRemoveAgainMs(5 * 60 * 1000);
    });

    it("deletes everything under the blog's prefix but the manifests on disconnect, and leaves a tombstone", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await this.local.writeAndPush("/b.txt", "B");
      var before = await setup.expectMirrored(this);

      var store = this.stores[this.blog.id];
      expect((await packsLeft(store)).length).toBeGreaterThan(0);

      await disconnected(this.blog.id);

      expect(await packsLeft(store)).toEqual([]);
      var fresh = Object.assign({}, store, { id: store.id });
      var tombstone = await manifest.read(fresh);
      expect(tombstone.seq).toBe(before.seq + 1);
      expect(manifest.isEmpty(tombstone)).toBe(true);
      expect(this.shadowLines("remove")[0]).toContain("outcome=ok");
    });

    it("drops a mirror queued just before the disconnect, and ignores later hooks", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var store = this.stores[this.blog.id];

      // Its mirror waits a moment before it starts: disconnect before then
      await this.local.writeAndPush("/b.txt", "B");
      await disconnected(this.blog.id);

      // Hooks which arrive late
      shadow.pushed(this.blog.id, 1);
      shadow.committed(this.blog.id, { path: "/c.txt", contents: "C" }, { parent: null, commit: "0".repeat(40) }, 1);

      await sleep(500);
      await shadow.idle(this.blog.id);

      expect(await packsLeft(store)).toEqual([]);
      expect(manifest.isEmpty(await manifest.read(Object.assign({}, store, { id: store.id })))).toBe(true);
    });

    it("deletes the copy again later, for work another process had started", async function () {
      shadow._setRemoveAgainMs(100);

      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var store = this.stores[this.blog.id];

      await disconnected(this.blog.id);

      // What another process's push, already running, uploads afterwards
      await store.put(PACK, Buffer.from("x"));

      await sleep(1000);

      expect(await packsLeft(store)).toEqual([]);
    });

    it("keeps the copy when the later lookup of the blog fails", async function () {
      shadow._setRemoveAgainMs(100);

      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var store = this.stores[this.blog.id];
      var Blog = require("models/blog");
      var get = Blog.get;

      await disconnected(this.blog.id);

      // Reconnected, and imported by another process, but Redis fails the lookup
      await store.put(PACK, Buffer.from("x"));
      Blog.get = function (by, callback) {
        callback(new Error("Redis went away"));
      };

      try {
        await sleep(1000);
      } finally {
        Blog.get = get;
      }

      expect(await packsLeft(store)).toEqual([PACK]);
      expect(this.shadowLines("remove").filter((line) => /outcome=spared pass=2/.test(line)).length).toBe(1);
    });

    it("disconnects with shadow mode off and no bucket", async function () {
      await this.local.writeAndPush("/a.txt", "A");

      config.git_store.shadow = "";
      shadow._setObjectStore(null);

      var bucket = config.storage.bucket;
      config.storage.bucket = "";

      try {
        await disconnected(this.blog.id);
      } finally {
        config.storage.bucket = bucket;
      }

      expect(this.shadowLines("remove").filter((line) => /outcome=error/.test(line))).toEqual([]);
    });
  });

  describe("with a slow store", function () {
    setup({
      objectStore: function (blogID) {
        var store = (this.stores[blogID] = this.stores[blogID] || createMemoryStore());
        var slow = Object.assign({}, store, { id: store.id });

        slow.putIfAbsent = async function (key, buffer) {
          await sleep(600);
          return store.putIfAbsent(key, buffer);
        };

        return slow;
      },
    });

    it("waits for a running mirror before deleting, so it is not recreated", async function () {
      await this.local.writeAndPush("/a.txt", "A");

      // The import has started and is waiting on its swap
      await sleep(500);
      await disconnected(this.blog.id);
      await shadow.idle(this.blog.id);
      await sleep(200);

      expect(await packsLeft(this.stores[this.blog.id])).toEqual([]);
    });
  });
});
