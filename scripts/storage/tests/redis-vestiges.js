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
    // Only the entries in the list are looked at; a deleted entry which is
    // not in it is not found
    await client.set(
      remember(entryKey.entry(blogID, "/unlisted.txt")),
      entry("/unlisted.txt", { deleted: true })
    );
    await client.zAdd(list, [
      { score: 1, value: "/old.txt" },
      { score: 1, value: "/live.txt" },
      { score: 1, value: "/expiring.txt" },
    ]);

    var report = await vestiges.deletedEntries({ only: blogID });

    expect(report.found).toBe(1);
    expect(await client.ttl(deletedKey)).toBe(-1);
    expect(await client.zScore(list, "/old.txt")).toBe(1);

    var applied = await vestiges.deletedEntries({ only: blogID, apply: true });

    expect(applied.fixed).toBe(1);
    expect(await client.ttl(deletedKey)).toBeGreaterThan(
      DELETED_ENTRY_TTL_SECONDS - 10
    );
    expect(await client.zScore(list, "/old.txt")).toBeGreaterThan(1000);
    expect(await client.ttl(liveKey)).toBe(-1);
    expect(await client.ttl(expiringKey)).toBeLessThanOrEqual(100);
    expect(await client.zScore(list, "/expiring.txt")).toBe(1);
    expect(await client.zScore(list, "/live.txt")).toBe(1);

    expect((await vestiges.deletedEntries({ only: blogID })).found).toBe(0);
  });

  it("deleted-entries fixes every entry of a list longer than a page", async function () {
    var blogID = this.blog.id;
    var list = remember("blog:" + blogID + ":deleted");
    var keys = [];

    // Re-scoring moves a fixed entry to the end of the list: all must still
    // be fixed in one run
    for (var i = 0; i < 250; i++) {
      var id = "/old-" + i + ".txt";
      var key = remember(entryKey.entry(blogID, id));
      keys.push(key);
      await client.set(key, entry(id, { deleted: true }));
      await client.zAdd(list, { score: i, value: id });
    }

    var applied = await vestiges.deletedEntries({ only: blogID, apply: true });

    expect(applied.fixed).toBe(250);
    for (var k of keys) expect(await client.ttl(k)).toBeGreaterThan(0);
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

  it("dropbox-members removes the blogs no webhook would sync from a set", async function () {
    var Blog = require("models/blog");
    var set = remember("clients:dropbox:vestiges-test");
    var account = remember("blog:" + this.blog.id + ":dropbox:account");
    var gone = "blog_" + "e5f6a7b8".repeat(4);

    await Blog.set(this.blog.id, { client: "dropbox" });
    await client.hSet(account, { account_id: "vestiges-test" });
    await client.sAdd(set, [this.blog.id, gone]);

    expect(
      (await vestiges.dropboxMembers({ only: "vestiges-test" })).stale
    ).toBe(1);
    expect(await client.sCard(set)).toBe(2);

    await vestiges.dropboxMembers({ only: "vestiges-test", apply: true });

    expect(await client.sMembers(set)).toEqual([this.blog.id]);

    // On another client now, so its membership goes too
    await Blog.set(this.blog.id, { client: "" });
    await vestiges.dropboxMembers({ only: "vestiges-test", apply: true });
    expect(await client.exists(set)).toBe(0);
  });

  it("dropbox-members empties a set whose account matches no blog's", async function () {
    var Blog = require("models/blog");
    var set = remember("clients:dropbox:vestiges-undefined");

    await Blog.set(this.blog.id, { client: "dropbox" });
    await client.sAdd(set, this.blog.id);

    await vestiges.dropboxMembers({ only: "vestiges-undefined", apply: true });

    expect(await client.exists(set)).toBe(0);
    await Blog.set(this.blog.id, { client: "" });
  });

  it("dropbox-accounts deletes the account of a blog on another client", async function () {
    var Blog = require("models/blog");
    var blogID = this.blog.id;
    var account = remember("blog:" + blogID + ":dropbox:account");
    var token = remember("blog:" + blogID + ":dropbox:access-token");
    var set = remember("clients:dropbox:vestiges-left");

    await client.hSet(account, { account_id: "vestiges-left" });
    await client.set(token, "{}");
    await client.sAdd(set, blogID);

    await Blog.set(blogID, { client: "dropbox" });
    expect(
      (await vestiges.dropboxAccounts({ only: blogID, apply: true })).deleted
    ).toBe(0);
    expect(await client.exists(account)).toBe(1);

    await Blog.set(blogID, { client: "icloud" });
    expect((await vestiges.dropboxAccounts({ only: blogID })).left).toBe(1);
    expect(await client.exists(account)).toBe(1);

    await vestiges.dropboxAccounts({ only: blogID, apply: true, recheckMs: 0 });

    expect(await client.exists(account)).toBe(0);
    expect(await client.exists(token)).toBe(0);
    expect(await client.exists(set)).toBe(0);
    await Blog.set(blogID, { client: "" });
  });

  it("dropbox-legacy deletes the old client's dropbox:<user id> sets only", async function () {
    var legacy = remember("dropbox:990011");
    var other = remember("dropbox:990011x");

    await client.sAdd(legacy, "blog_x");
    await client.sAdd(other, "blog_x");

    await vestiges.dropboxLegacy({ only: "990011*", apply: true });

    expect(await client.exists(legacy)).toBe(0);
    expect(await client.exists(other)).toBe(1);
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

    await vestiges.permalinks({ only: blogID, apply: true, wait: 0 });

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

    await vestiges.rendered({ only: "vestiges-*", apply: true, wait: 0 });

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

  it("deleted-blogs treats an info hash with no handle or owner as a ghost", async function () {
    var ghost = "blog_" + "1a2b3c4d".repeat(4);
    var owned = "blog_" + "2a2b3c4d".repeat(4);
    var listed = "blog_" + "3a2b3c4d".repeat(4);
    var ghostKeys = [
      remember("blog:" + ghost + ":info"),
      remember("blog:" + ghost + ":all"),
    ];
    var ownedInfo = remember("blog:" + owned + ":info");
    var listedInfo = remember("blog:" + listed + ":info");

    await client.hSet(ghostKeys[0], { status: "{}", cacheID: "1" });
    await client.set(ghostKeys[1], "x");
    await client.hSet(ownedInfo, { owner: "user_x", cacheID: "1" });
    await client.hSet(listedInfo, { cacheID: "1" });
    await client.sAdd("blogs", listed);

    try {
      var report = await vestiges.deletedBlogs({ only: "blog_*" });

      expect(report.blogs).toContain(ghost);
      expect(report.blogs).not.toContain(owned);
      expect(report.blogs).not.toContain(listed);
      expect(await client.exists(ghostKeys)).toBe(2);

      await vestiges.deletedBlogs({ only: ghost, apply: true });

      expect(await client.exists(ghostKeys)).toBe(0);
      expect(await client.exists([ownedInfo, listedInfo])).toBe(2);
    } finally {
      await client.sRem("blogs", listed);
    }
  });

  it("ssl-history deletes certificate versions with a 13 digit time only", async function () {
    var old = remember("ssl:vestiges-h.example:1500000000000");
    var keep = [
      remember("ssl:vestiges-h.example:latest"),
      remember("ssl:vestiges-h.example:challenge:abc"),
      remember("ssl:vestiges-h.example:issue_cert_lock"),
      remember("ssl:vestiges-h.example:123456789012"),
    ];

    await client.set(old, "x");
    for (var key of keep) await client.set(key, "x");

    expect((await vestiges.sslHistory({ only: "vestiges-h*" })).found).toBe(1);
    expect(await client.exists(old)).toBe(1);

    await vestiges.sslHistory({ only: "vestiges-h*", apply: true });

    expect(await client.exists(old)).toBe(0);
    expect(await client.exists(keep)).toBe(4);
  });

  it("ssl-challenges deletes tokens with no TTL still without one after the wait", async function () {
    var stuck = remember("ssl:vestiges-c.example:challenge:stuck");
    var live = remember("ssl:vestiges-c.example:challenge:live");
    var renewed = remember("ssl:vestiges-c.example:challenge:renewed");
    var latest = remember("ssl:vestiges-c.example:latest");

    await client.set(stuck, "x");
    await client.set(live, "x", { EX: 600 });
    await client.set(renewed, "x");
    await client.set(latest, "x");

    var report = await vestiges.sslChallenges({ only: "vestiges-c*" });

    expect(report.found).toBe(2);
    expect(await client.exists([stuck, renewed])).toBe(2);

    // One gets a TTL during the wait, as an issuance in progress would
    var run = vestiges.sslChallenges({
      only: "vestiges-c*",
      apply: true,
      wait: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.expire(renewed, 600);

    var applied = await run;

    expect(applied.deleted).toBe(1);
    expect(await client.exists(stuck)).toBe(0);
    expect(await client.exists([live, renewed, latest])).toBe(3);
  });

  it("lookups deletes keys which name a blog or user that is gone, not the rest", async function () {
    var Blog = require("models/blog");
    var userKey = require("models/user/key");
    var goneBlog = "blog_" + "4a2b3c4d".repeat(4);
    var goneUser = "user_VESTIGESGONE";
    var liveUser = "user_VESTIGESLIVE";
    var dead = [
      remember("handle:vestiges-gone"),
      remember("domain:vestiges-gone.example"),
      remember("handle:vestiges-numeric"),
      remember("email:vestiges-gone@example.com"),
      remember("customer:vestiges-gone"),
      remember("paypal:vestiges-gone"),
      remember("email:vestiges-numeric@example.com"),
    ];
    var kept = [
      remember("handle:vestiges-live"),
      remember("domain:vestiges-live.example"),
      remember("handle:vestiges-odd"),
      remember("email:vestiges-live@example.com"),
      remember("customer:vestiges-live"),
      remember("handle:vestiges-numeric-live"),
    ];

    await client.set(dead[0], goneBlog);
    await client.set(dead[1], goneBlog);
    await client.set(dead[2], "12345");
    await client.set(dead[3], goneUser);
    await client.set(dead[4], goneUser);
    await client.set(dead[5], goneUser);
    await client.set(dead[6], "678");
    await client.set(kept[0], this.blog.id);
    await client.set(kept[1], this.blog.id);
    await client.set(kept[2], "not an id");
    await client.set(kept[3], liveUser);
    await client.set(kept[4], liveUser);
    await client.set(kept[5], "4242");
    await client.sAdd(userKey.uids, liveUser);
    await client.sAdd(Blog.key.ids, "4242");

    try {
      var report = await vestiges.lookups({ only: "vestiges-*" });

      expect(report.dangling).toBe(7);
      expect(report.unrecognised).toBe(1);
      expect(await client.exists(dead)).toBe(7);

      var applied = await vestiges.lookups({
        only: "vestiges-*",
        apply: true,
        wait: 0,
      });

      expect(applied.deleted).toBe(7);
      expect(await client.exists(dead)).toBe(0);
      expect(await client.exists(kept)).toBe(6);
    } finally {
      await client.sRem(userKey.uids, liveUser);
      await client.sRem(Blog.key.ids, "4242");
    }
  });

  it("lookups leaves a key whose value changes during the wait", async function () {
    var key = remember("handle:vestiges-changing");
    var gone = "blog_" + "5a2b3c4d".repeat(4);

    await client.set(key, gone);

    var run = vestiges.lookups({ only: "vestiges-*", apply: true, wait: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.set(key, this.blog.id);

    expect((await run).deleted).toBe(0);
    expect(await client.get(key)).toBe(this.blog.id);
  });

  it("removed-users deletes the keys of a removed account, and only reports one with a record", async function () {
    var userKey = require("models/user/key");
    var removed = "user_VESTIGESRMD";
    var orphan = "user_VESTIGESORP";
    var live = "user_VESTIGESLV";
    var dead = [
      remember("user:" + removed + ":git:token"),
      remember("user:" + removed + ":git:status"),
      remember("user:" + removed + ":paypal_cancel_email:I-1"),
    ];
    var kept = [
      remember("user:" + orphan + ":git:token"),
      remember(userKey.user(orphan)),
      remember("user:" + live + ":git:token"),
      remember(userKey.user(live)),
    ];

    for (var key of dead.concat(kept)) await client.set(key, "x");
    await client.sAdd(userKey.uids, live);

    try {
      var report = await vestiges.removedUsers({ only: "user_VESTIGES*" });

      expect(report.users).toEqual([removed]);
      expect(report.review).toEqual([orphan]);
      expect(report.keys).toBe(3);
      expect(await client.exists(dead)).toBe(3);

      await vestiges.removedUsers({
        only: "user_VESTIGES*",
        apply: true,
        wait: 0,
      });

      expect(await client.exists(dead)).toBe(0);
      expect(await client.exists(kept)).toBe(4);
    } finally {
      await client.sRem(userKey.uids, live);
    }
  });

  it("legacy deletes keys of removed code, not those of current blogs", async function () {
    var dead = [
      remember("image:dimensions:vestiges-1"),
      remember("switch-blog-id-format:vestiges-1"),
      remember("sync:again:vestiges-1"),
      remember("sync:lease:vestiges-1"),
      remember("blog:99001122:info"),
      remember("blog:99001122:upload:file:x"),
      remember("blot:stats"),
    ];
    var kept = [
      remember("blog:" + this.blog.id + ":vestiges-legacy"),
      remember("blog:SITE:vestiges-legacy"),
      remember("blog:99001122x:info"),
    ];

    await client.hSet(dead[4], { handle: "x" });
    for (var key of dead.slice(0, 4).concat(dead.slice(5), kept))
      await client.set(key, "x");

    // The exact keys are only looked for when the run is over everything,
    // or the keys are given
    var exact = ["blot:stats"];

    var scoped = await vestiges.legacy({ only: "vestiges-1" });

    expect(scoped.found).toBe(4);
    expect(await client.exists(dead)).toBe(7);

    await vestiges.legacy({ only: "vestiges-1", apply: true });
    await vestiges.legacy({ only: "99001122", apply: true, exact: exact });

    expect(await client.exists(dead)).toBe(0);
    expect(await client.exists(kept)).toBe(3);
  });

  it("legacy leaves a numeric blog ID which the blogs set still lists", async function () {
    var Blog = require("models/blog");
    var info = remember("blog:99001123:info");

    await client.hSet(info, { handle: "x" });
    await client.sAdd(Blog.key.ids, "99001123");

    try {
      var applied = await vestiges.legacy({
        only: "99001123",
        apply: true,
        exact: [],
      });

      expect(applied.deleted).toBe(0);
      expect(await client.exists(info)).toBe(1);
    } finally {
      await client.sRem(Blog.key.ids, "99001123");
    }
  });
});
