describe("scripts/storage/redis-vestiges", function () {
  var client = require("models/client");
  var config = require("config");
  var entryKey = require("models/entry/key");
  var templateKey = require("models/template/key");
  var vestiges = require("../redis-vestiges");
  var {
    DELETED_ENTRY_TTL_SECONDS,
  } = require("models/entries/sweepExpiredDeleted");

  global.test.blog();

  var created = [];

  function remember(key) {
    created.push(key);
    return key;
  }

  afterEach(async function () {
    if (created.length) await client.del(created);
    created = [];
  });

  beforeEach(function () {
    this.quiet = spyOn(console, "log");
  });

  function entry(id, fields) {
    return JSON.stringify(Object.assign({ id: id, path: id }, fields));
  }

  it("deleted-entries gives only deleted entries with no TTL a TTL", async function () {
    var blogID = this.blog.id;
    var deletedKey = remember(entryKey.entry(blogID, "/old.txt"));
    var liveKey = remember(entryKey.entry(blogID, "/live.txt"));
    var expiringKey = remember(entryKey.entry(blogID, "/expiring.txt"));
    var list = remember("blog:" + blogID + ":deleted");

    await client.set(deletedKey, entry("/old.txt", { deleted: true }));
    await client.set(liveKey, entry("/live.txt", { deleted: false }));
    await client.set(expiringKey, entry("/expiring.txt", { deleted: true }));
    await client.expire(expiringKey, 100);

    var report = await vestiges.deletedEntries({ only: blogID });

    expect(report.found).toBe(1);
    expect(await client.ttl(deletedKey)).toBe(-1);
    expect(await client.zCard(list)).toBe(0);

    var applied = await vestiges.deletedEntries({ only: blogID, apply: true });

    expect(applied.fixed).toBe(1);
    expect(await client.ttl(deletedKey)).toBeGreaterThan(
      DELETED_ENTRY_TTL_SECONDS - 10
    );
    expect(await client.zScore(list, "/old.txt")).not.toBeNull();
    expect(await client.ttl(liveKey)).toBe(-1);
    expect(await client.ttl(expiringKey)).toBeLessThanOrEqual(100);
    expect(await client.zScore(list, "/expiring.txt")).toBeNull();

    expect((await vestiges.deletedEntries({ only: blogID })).found).toBe(0);
  });

  it("deleted-blogs deletes the keys of a blog which is gone, not of one which exists", async function () {
    var gone = "blog_" + "a1b2c3d4".repeat(4);
    var keys = [
      "blog:" + gone + ":entry:/a.txt",
      "blog:" + gone + ":all",
      "template:" + gone + ":main:info",
      "template:owned_by:" + gone,
    ];

    for (var key of keys) await client.set(remember(key), "x");

    var live = remember("blog:" + this.blog.id + ":vestiges-test");
    await client.set(live, "x");

    var report = await vestiges.deletedBlogs({ only: gone });

    expect(report.blogs).toEqual([gone]);
    expect(report.keys).toBe(4);
    expect(await client.exists(keys)).toBe(4);

    expect((await vestiges.deletedBlogs({ only: this.blog.id })).keys).toBe(0);

    await vestiges.deletedBlogs({ only: gone, apply: true });

    expect(await client.exists(keys)).toBe(0);
    expect(await client.exists(live)).toBe(1);

    await vestiges.deletedBlogs({ only: this.blog.id, apply: true });

    expect(await client.exists(live)).toBe(1);
    expect(await client.exists("blog:" + this.blog.id + ":info")).toBe(1);
  });

  it("dropbox-members removes the blogs which are gone from a set", async function () {
    var set = remember("clients:dropbox:vestiges-test");
    var gone = "blog_" + "e5f6a7b8".repeat(4);

    await client.sAdd(set, [this.blog.id, gone]);

    expect(
      (await vestiges.dropboxMembers({ only: "vestiges-test" })).stale
    ).toBe(1);
    expect(await client.sCard(set)).toBe(2);

    await vestiges.dropboxMembers({ only: "vestiges-test", apply: true });

    expect(await client.sMembers(set)).toEqual([this.blog.id]);
  });

  it("template-shares deletes a share whose template is gone, not one whose template exists", async function () {
    var liveTemplate = this.blog.id + ":vestiges-live";
    var share = remember(templateKey.share("vestiges-gone"));
    var liveShare = remember(templateKey.share("vestiges-live"));

    await client.hSet(
      remember(templateKey.metadata(liveTemplate)),
      "name",
      "x"
    );
    await client.set(share, this.blog.id + ":vestiges-dropped");
    await client.set(liveShare, liveTemplate);

    expect((await vestiges.templateShares({ only: "vestiges-*" })).stale).toBe(
      1
    );
    expect(await client.exists(share)).toBe(1);

    await vestiges.templateShares({ only: "vestiges-*", apply: true });

    expect(await client.exists(share)).toBe(0);
    expect(await client.exists(liveShare)).toBe(1);
  });

  it("permalinks deletes keys whose entry is gone, and keeps redirects", async function () {
    var blogID = this.blog.id;
    var url = (u) => remember("blog:" + blogID + ":url:" + u);
    var gone = url("/gone");
    var current = url("/current");
    var redirect = url("/old-url");
    var deleted = url("/deleted");

    await client.set(
      remember(entryKey.entry(blogID, "/a.txt")),
      entry("/a.txt", { url: "/current" })
    );
    await client.set(
      remember(entryKey.entry(blogID, "/b.txt")),
      entry("/b.txt", { deleted: true })
    );
    await client.set(current, "/a.txt");
    await client.set(redirect, "/a.txt");
    await client.set(deleted, "/b.txt");
    await client.set(gone, "/missing.txt");

    var report = await vestiges.permalinks({ only: blogID });

    expect(report.stale).toBe(1);
    expect(await client.exists(gone)).toBe(1);

    await vestiges.permalinks({ only: blogID, apply: true });

    expect(await client.exists(gone)).toBe(0);
    expect(await client.exists([current, redirect, deleted])).toBe(3);
  });

  it("rendered deletes an output no template references, not one it does", async function () {
    var templateID = this.blog.id + ":vestiges-rendered";
    var referenced = remember(templateKey.renderedOutput("vestiges-ref"));
    var orphan = remember(templateKey.renderedOutput("vestiges-orphan"));

    await client.set(referenced, "a{}");
    await client.set(orphan, "b{}");
    await client.hSet(remember(templateKey.metadata(templateID)), {
      name: "x",
      cdn: JSON.stringify({
        "style.css": "vestiges-ref",
        "logo.png": { path: "/logo.png", version: "v1" },
      }),
    });

    var report = await vestiges.rendered({ only: "vestiges-*" });

    expect(report.unreferenced).toBe(1);
    expect(await client.exists(orphan)).toBe(1);

    await vestiges.rendered({ only: "vestiges-*", apply: true });

    expect(await client.exists(orphan)).toBe(0);
    expect(await client.exists(referenced)).toBe(1);
  });

  it("ssl deletes expired certificates without a domain key, and wildcard-covered ones, not the rest", async function () {
    var now = Date.now();
    var cert = (domain, days) =>
      client.set(
        remember("ssl:" + domain + ":latest"),
        JSON.stringify({ expiry: Math.floor((now + days * 864e5) / 1000) })
      );

    await cert("vestiges-expired.example", -3);
    await cert("vestiges-renewed.example", -3);
    await cert("vestiges-fresh.example", 40);
    await cert("vestiges-sub." + config.host, -3);
    await cert("vestiges-sub-fresh." + config.host, 40);
    await client.set(remember("domain:vestiges-renewed.example"), this.blog.id);

    expect((await vestiges.ssl({ only: "vestiges-*", now })).stale).toBe(2);
    expect(await client.exists("ssl:vestiges-expired.example:latest")).toBe(1);

    await vestiges.ssl({ only: "vestiges-*", apply: true, now });

    expect(await client.exists("ssl:vestiges-expired.example:latest")).toBe(0);
    expect(
      await client.exists("ssl:vestiges-sub." + config.host + ":latest")
    ).toBe(0);
    expect(await client.exists("ssl:vestiges-renewed.example:latest")).toBe(1);
    expect(await client.exists("ssl:vestiges-fresh.example:latest")).toBe(1);
    expect(
      await client.exists("ssl:vestiges-sub-fresh." + config.host + ":latest")
    ).toBe(1);
  });

  it("removed-features counts without apply, and removes with it", async function () {
    var ignored = remember("blog:" + this.blog.id + ":ignored_files");

    await client.hSet(ignored, "/a.md", "PUBLIC_FILE");

    expect(
      (await vestiges.removedFeatures({ only: this.blog.id })).ignoredFiles
    ).toBe(1);
    expect(await client.exists(ignored)).toBe(1);

    await vestiges.removedFeatures({ only: this.blog.id, apply: true });

    expect(await client.exists(ignored)).toBe(0);
  });
});
