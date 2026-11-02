describe("git store shadow mode: failures, coalescing and switching off", function () {
  var setup = require("./setup");
  var shadow = require("clients/git/shadow");
  var repo = require("clients/git/repo");
  var config = require("config");
  var { createMemoryStore, createS3Store } = require("clients/git/store");

  function commit(ctx, change) {
    return new Promise(function (resolve, reject) {
      repo.commit(ctx.blog.id, change, function (err) {
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

  describe("with an object store which fails", function () {
    setup({
      objectStore: function (blogID) {
        var store = (this.stores[blogID] = this.stores[blogID] || createMemoryStore());
        var broken = Object.assign({}, store, { id: store.id });

        broken.put = broken.putIfAbsent = async function () {
          throw new Error("injected failure");
        };

        return broken;
      },
    });

    it("leaves the push, the sync and Blot's writes as they were", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await this.local.expectSynced();
      await this.local.writeAndPush("/b.txt", "B");
      await this.local.expectSynced();

      await commit(this, { path: "/c.txt", contents: "C" });
      expect(await require("fs-extra").readFile(this.blogDirectory + "/c.txt", "utf8")).toBe("C");

      await shadow.idle(this.blog.id);

      var lines = this.shadowLines();
      expect(lines.length).toBeGreaterThan(0);
      lines.forEach(function (line) {
        expect(line).not.toMatch(/outcome=(ok|imported)\b/);
      });
      expect(lines.join("\n")).toContain("injected failure");
    });
  });

  describe("with a slow object store", function () {
    setup({
      objectStore: function (blogID) {
        var store = (this.stores[blogID] = this.stores[blogID] || createMemoryStore());
        var slow = Object.assign({}, store, { id: store.id });

        slow.putIfAbsent = async function (key, buffer) {
          await sleep(150);
          return store.putIfAbsent(key, buffer);
        };

        return slow;
      },
    });

    it("coalesces pushes in quick succession, never overlapping mirrors", async function () {
      await this.local.writeAndPush("/a.txt", "A");

      // Pushes from several clones, without waiting for the shadow
      for (var i = 0; i < 5; i++) {
        await this.local.commitFiles({ ["/" + i + ".txt"]: String(i) });
        await this.local.git(["push", "origin", "master"]);
      }

      await this.local.waitForSync();
      await setup.expectMirrored(this);

      expect(shadow.stats.overlaps).toBe(0);
      expect(shadow.stats.mirrors).toBeLessThanOrEqual(6);

      var oks = this.lines.filter(function (line) {
        return /op=(push|import) outcome=(ok|imported|same)/.test(line);
      });
      expect(oks.length).toBe(shadow.stats.mirrors);
    });
  });

  describe("switched off", function () {
    var made;

    setup({
      shadow: "",
      objectStore: function () {
        made++;
        return createMemoryStore();
      },
    });

    beforeEach(function () {
      made = 0;
      spyOn(shadow, "pushed").and.callThrough();
      spyOn(shadow, "committed").and.callThrough();
    });

    it("makes no store and no store call", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await commit(this, { path: "/b.txt", contents: "B" });

      // On for other blogs only
      config.git_store.shadow = "blog_none, blog_other";
      await commit(this, { path: "/d.txt", contents: "D" });
      await this.local.pull();
      await this.local.writeAndPush("/c.txt", "C");

      await shadow.idle(this.blog.id);

      expect(made).toBe(0);
      expect(shadow.pushed).not.toHaveBeenCalled();
      expect(shadow.committed).not.toHaveBeenCalled();
      expect(this.shadowLines().length).toBe(0);
    });

    it("switches on for a listed blog", async function () {
      config.git_store.shadow = "blog_other," + this.blog.id;
      await this.local.writeAndPush("/a.txt", "A");
      await shadow.idle(this.blog.id);

      expect(made).toBe(1);
      expect(shadow.pushed).toHaveBeenCalledTimes(1);
    });
  });

  // The store the app uses: the storage bucket (MinIO in tests), under
  // git/<blogID>/. Only when the test runner provides MinIO.
  (config.storage.endpoint ? describe : xdescribe)("in the storage bucket", function () {
    setup({ objectStore: null });

    beforeEach(function () {
      shadow._setObjectStore(null);
    });

    it("mirrors pushes and writes", async function () {
      var s3 = require("storage/s3");
      var store = createS3Store({ client: s3.client(), bucket: config.storage.bucket, prefix: "git/" + this.blog.id + "/" });

      await this.local.writeAndPush("/a.txt", "A");
      await this.local.writeAndPush("/b.txt", "B");
      await commit(this, { path: "/c.txt", contents: "C" });

      await setup.expectMirrored(this, store);

      var lines = this.shadowLines();
      expect(lines.some((line) => /op=import outcome=imported/.test(line))).toBe(true);
      expect(lines.some((line) => /op=push outcome=ok/.test(line))).toBe(true);
      expect(lines.some((line) => /op=write outcome=ok/.test(line))).toBe(true);
      lines.forEach(function (line) {
        expect(line).not.toMatch(/outcome=(error|failed|mismatch)/);
      });
    });
  });
});
