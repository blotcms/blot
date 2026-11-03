describe("git store shadow mode: daily maintenance", function () {
  var setup = require("./setup");
  var config = require("config");
  var maintenance = require("clients/git/shadow/maintenance");
  var gitStoreMaintenance = require("scheduler/git-store-maintenance");
  var { manifest, layout, createMemoryStore } = require("clients/git/store");

  var DAY = 24 * 60 * 60 * 1000;

  setup();

  beforeEach(function () {
    var ctx = this;

    // Only this blog: other specs' blogs may be in the database
    config.git_store.shadow = ctx.blog.id;

    // The bucket's git/ prefixes are the memory stores with anything in them
    maintenance._setPrefixLister(async function* () {
      for (var blogID of Object.keys(ctx.stores)) {
        var store = ctx.stores[blogID];
        if (!store) continue;
        for await (var entry of store.list("")) {
          yield blogID;
          break;
        }
      }
    });

    this.check = function (extra) {
      return maintenance.verify(ctx.blog.id, Object.assign({ recheckDelayMs: 10, scratchDir: ctx.tmp + "/verify-scratch" }, extra));
    };
  });

  afterEach(function () {
    maintenance._setPrefixLister(null);
  });

  async function behind(ctx) {
    await ctx.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(ctx);

    // A push the store never heard of
    config.git_store.shadow = "";
    await ctx.local.writeAndPush("/b.txt", "B");
    config.git_store.shadow = ctx.blog.id;
  }

  async function keys(store) {
    var found = [];
    for await (var entry of store.list("")) found.push(entry.key);
    return found;
  }

  describe("the verifier", function () {
    it("is ok when the store is in sync", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await this.local.git(["tag", "-a", "annotated", "-m", "An annotated tag"]);
      await this.local.push(["origin", "--tags"]);
      await setup.expectMirrored(this);

      var result = await this.check();

      expect(result.findings).toEqual([]);
      var line = this.shadowLines("verify")[0];
      expect(line).toContain("outcome=ok");
      expect(line).toContain("check=cheap");
      expect(line).not.toContain(this.blog.handle);
    });

    it("finds a mismatch when the store is behind, after checking again", async function () {
      await behind(this);

      var result = await this.check();

      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("mismatch");
      expect(result.findings[0].detail).toContain("refs/heads/master");
      expect(this.shadowLines("verify")[0]).toContain("outcome=mismatch");
      expect(this.shadowLines("verify")[0]).toContain("attempts=2");
    });

    it("does not count a push which lands before the check runs again", async function () {
      await behind(this);

      var ctx = this;
      var result = await maintenance.verify(this.blog.id, { recheckDelayMs: 300 });
      expect(result.findings.length).toBe(1);

      // The mirror catches up while the check waits
      setTimeout(function () {
        require("clients/git/shadow").mirror(ctx.blog.id);
      }, 0);
      result = await maintenance.verify(this.blog.id, { recheckDelayMs: 1500 });
      expect(result.findings).toEqual([]);
    });

    it("finds a pack the manifest names missing", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      var current = await setup.expectMirrored(this);
      var store = this.stores[this.blog.id];

      await store.delete(layout.packKey(current.packs[0].name));

      var result = await this.check();

      expect(result.findings.length).toBe(1);
      expect(result.findings[0].kind).toBe("missing");
      expect(result.findings[0].detail).toContain(current.packs[0].name + ".pack");
      expect(this.shadowLines("verify")[0]).toContain("outcome=missing");
    });

    it("passes the deep check on a good repository and fails it on a corrupted pack", async function () {
      await this.local.writeAndPush("/a.txt", "A".repeat(2000));
      await this.local.writeAndPush("/b.txt", "B".repeat(2000));
      var current = await setup.expectMirrored(this);

      var result = await this.check({ deep: true });
      expect(result.deep).toBe(true);
      expect(result.findings).toEqual([]);
      expect(this.shadowLines("verify").filter((line) => /check=deep/.test(line))[0]).toContain("outcome=ok");

      // The same size, so only a clone notices
      var store = this.stores[this.blog.id];
      var key = layout.packKey(current.packs[current.packs.length - 1].name);
      var bytes = Buffer.from(await store.get(key, { maxBytes: 1e8 }));
      for (var i = 20; i < bytes.length - 20; i++) bytes[i] ^= 0xff;
      await store.put(key, bytes);

      result = await this.check({ deep: true });
      expect(result.findings.length).toBe(1);
      expect(result.findings[0].check).toBe("deep");
      expect(["mismatch", "missing"]).toContain(result.findings[0].kind);
    });

    it("counts a deep check that fails for want of scratch space as an error, not a mismatch", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      // Scratch is a file, so the clone has nowhere to go
      var file = this.tmp + "/not-a-directory";
      require("fs").writeFileSync(file, "x");

      var result = await this.check({ deep: true, scratchDir: file + "/scratch" });

      expect(result.findings.length).toBe(1);
      expect(result.findings[0].check).toBe("deep");
      expect(result.findings[0].kind).toBe("error");
      expect(this.shadowLines("verify").filter((line) => /check=deep/.test(line))[0]).toContain("outcome=error");
    });

    it("tells a verdict on the store from trouble on this machine", function () {
      var { CorruptError, NotFoundError } = require("clients/git/store").errors;
      var coded = function (message, code) {
        return Object.assign(new Error(message), { code: code });
      };

      expect(maintenance._verdict(new CorruptError("The store's refs differ from the source's"))).toBe("mismatch");
      expect(maintenance._verdict(new NotFoundError("No such key: packs/pack-x.pack"))).toBe("missing");
      expect(maintenance._verdict(new Error("git index-pack --strict --fsck-objects x.pack failed: fatal: pack has bad object at offset 12"))).toBe("mismatch");
      expect(maintenance._verdict(new Error("git fsck --strict --no-dangling failed: missing blob 1234"))).toBe("mismatch");

      expect(maintenance._verdict(coded("ENOSPC: no space left on device, write", "ENOSPC"))).toBe(null);
      expect(maintenance._verdict(coded("EACCES: permission denied, mkdtemp", "EACCES"))).toBe(null);
      expect(maintenance._verdict(coded("EMFILE: too many open files", "EMFILE"))).toBe(null);
      expect(maintenance._verdict(coded("No room in the cache", "NO_ROOM"))).toBe(null);
      expect(maintenance._verdict(new Error("git index-pack --strict x.pack failed: fatal: unable to write: No space left on device"))).toBe(null);
      expect(maintenance._verdict(new Error("git init -q --bare clone.git failed: Permission denied"))).toBe(null);
      expect(maintenance._verdict(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(null);
    });
  });

  describe("the sweep", function () {
    it("runs the store's sweep and logs it", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await this.local.writeAndPush("/b.txt", "B");
      await setup.expectMirrored(this);

      var lists = this.stores[this.blog.id].stats.lists;
      var stats = await maintenance.sweepBlog(this.blog.id);

      expect(stats.manifestsDeleted).toBe(0);
      expect(stats.packsDeleted).toBe(0);
      expect(this.stores[this.blog.id].stats.lists).toBeGreaterThan(lists);
      expect(this.shadowLines("sweep")[0]).toMatch(/ op=sweep outcome=ok storeMs=\d+ requests=\d+ /);
    });
  });

  describe("prefixes left behind", function () {
    function old(ctx, blogID, ago) {
      var store = createMemoryStore({
        now: function () {
          return Date.now() - ago;
        },
      });
      ctx.stores[blogID] = store;
      return Promise.all([store.put("manifests/0000000001.json", Buffer.from("{}")), store.put("packs/pack-" + "a".repeat(40) + ".pack", Buffer.from("x"))]).then(function () {
        return store;
      });
    }

    it("deletes a deleted blog's prefix, spares a recent one, and never touches a live git blog's", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var gone = await old(this, "blog_gone", 2 * DAY);
      var recent = await old(this, "blog_recent", 60 * 1000);
      var live = this.stores[this.blog.id];
      var liveKeys = await keys(live);

      // Even a week on, the live blog's prefix stays
      var counts = await maintenance.orphans({ now: Date.now() });

      expect(await keys(gone)).toEqual([]);
      expect((await keys(recent)).length).toBe(2);
      expect(await keys(live)).toEqual(liveKeys);
      expect(counts.removed).toBe(1);
      expect(counts.spared).toBe(1);
      expect(counts.live).toBe(1);
      expect(counts.findings).toEqual([{ blog: "blog_gone", check: "orphan", kind: "orphan", detail: "deleted 2 objects left behind" }]);

      counts = await maintenance.orphans({ now: Date.now() + 7 * DAY });
      expect(await keys(recent)).toEqual([]);
      expect(await keys(live)).toEqual(liveKeys);
      expect(counts.live).toBe(1);

      expect(this.shadowLines("remove").filter((line) => / outcome=ok /.test(line)).length).toBe(2);
    });

    it("reports a prefix it could not clean up, and goes on to the rest", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var ctx = this;
      var gone = await old(this, "blog_gone", 2 * DAY);
      this.stores.blog_broken = {
        id: "broken",
        list: async function* () {
          throw new Error("listing failed");
        },
      };
      maintenance._setPrefixLister(async function* () {
        yield "blog_broken";
        yield "blog_gone";
        yield ctx.blog.id;
      });

      var counts = await maintenance.orphans();

      expect(counts.errors).toBe(1);
      expect(counts.removed).toBe(1);
      expect(await keys(gone)).toEqual([]);
      expect(counts.findings).toEqual([
        { blog: "blog_broken", check: "orphan", kind: "error", detail: "listing failed" },
        { blog: "blog_gone", check: "orphan", kind: "orphan", detail: "deleted 2 objects left behind" },
      ]);

      // The daily run emails it
      var sent = [];
      var result = await gitStoreMaintenance.run({
        recheckDelayMs: 10,
        deepCount: 0,
        orphanSweep: true,
        sendEmail: async function (view) {
          sent.push(view);
        },
      });

      expect(result.sent).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0].findings).toEqual([{ blog: "blog_broken", kind: "error", check: "orphan", detail: "listing failed" }]);
      expect(result.report.orphans.errors).toBe(1);
    });

    it("looks for prefixes left behind only on the first of the month", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var gone = await old(this, "blog_gone", 2 * DAY);
      var options = { deepCount: 0, recheckDelayMs: 10, scratchDir: this.tmp + "/daily-scratch" };

      var second = await maintenance.daily(Object.assign({ now: Date.UTC(2099, 0, 2) }, options));
      expect(second.orphans).toBe(null);
      expect((await keys(gone)).length).toBe(2);

      var first = await maintenance.daily(Object.assign({ now: Date.UTC(2099, 0, 1) }, options));
      expect(first.orphans.removed).toBe(1);
      expect(await keys(gone)).toEqual([]);
      expect(first.findings.map((f) => f.kind)).toEqual(["orphan"]);

      // And the alert email says so
      var sent = [];
      await gitStoreMaintenance.run(Object.assign({ orphanSweep: true, sendEmail: async (view) => sent.push(view) }, options));
      expect(sent).toEqual([]);

      await old(this, "blog_gone", 2 * DAY);
      await gitStoreMaintenance.run(Object.assign({ orphanSweep: true, sendEmail: async (view) => sent.push(view) }, options));
      expect(sent.length).toBe(1);
      expect(sent[0].summary).toBe("1 leftover in 1 blog");
      expect(sent[0].hasOrphans).toBe(true);
    });
  });

  describe("the daily job", function () {
    function run(ctx, sent) {
      return gitStoreMaintenance.run({
        recheckDelayMs: 10,
        orphanSweep: false,
        scratchDir: ctx.tmp + "/daily-scratch",
        sendEmail: async function (view) {
          sent.push(view);
        },
      });
    }

    it("sends no email when all is well, and deep checks the blog", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      var sent = [];
      var result = await run(this, sent);

      expect(sent).toEqual([]);
      expect(result.sent).toBe(false);
      expect(result.report.blogs).toBe(1);
      expect(result.report.sweeps.ok).toBe(1);
      expect(result.report.deepChecked).toBe(1);
      expect(this.shadowLines("sweep").length).toBe(1);
    });

    it("sends one email for several findings", async function () {
      await behind(this);

      var current = await manifest.read(this.stores[this.blog.id]);
      await this.stores[this.blog.id].delete(layout.idxKey(current.packs[0].name));

      var sent = [];
      var result = await run(this, sent);

      expect(result.sent).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0].findings.length).toBe(2);
      expect(sent[0].findings.map((f) => f.kind).sort()).toEqual(["mismatch", "missing"]);
      expect(sent[0].summary).toBe("1 missing file, 1 mismatch in 1 blog");
      sent[0].findings.forEach((finding) => expect(finding.blog).toBe(this.blog.id));
      expect(JSON.stringify(sent[0])).not.toContain(this.blog.handle);

      // A blog which failed the cheap check is not cloned
      expect(result.report.deepChecked).toBe(0);
    });

    it("does nothing with shadow mode off", async function () {
      config.git_store.shadow = "";

      var sent = [];
      var result = await run(this, sent);

      expect(result.skipped).toBe(true);
      expect(sent).toEqual([]);
    });
  });
});
