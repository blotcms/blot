var config = require("config");
var redis = require("models/client");
var key = require("../key");
var rawGet = require("../get");

describe("entry.get", function () {
  require("./setup")();

  var get = function (blogID, ids, fields) {
    return new Promise(function (resolve) {
      if (fields === undefined) {
        rawGet(blogID, ids, resolve);
      } else {
        rawGet(blogID, ids, fields, resolve);
      }
    });
  };

  describe("legacy JSON string path (readEntriesFromHash off)", function () {
    var previous;
    beforeEach(function () {
      previous = config.redis.readEntriesFromHash;
      config.redis.readEntriesFromHash = false;
    });
    afterEach(function () {
      config.redis.readEntriesFromHash = previous;
    });

    it("returns a whole entry from the JSON string", async function () {
      await this.set("/post.txt", "# Hello\n\nthe body");

      var entry = await get(this.blog.id, "/post.txt");

      expect(entry.path).toEqual("/post.txt");
      expect(entry.title).toEqual("Hello");
      expect(entry.html.length).toBeGreaterThan(0);
    });

    it("still works when the hash is missing (does not touch it)", async function () {
      await this.set("/post.txt", "# Hi\n\nbody");
      await redis.del(key.entryHash(this.blog.id, "/post.txt"));

      var entry = await get(this.blog.id, "/post.txt");
      expect(entry.title).toEqual("Hi");
    });

    it("ignores the fields argument", async function () {
      await this.set("/post.txt", "# Full\n\nbody");

      var entry = await get(this.blog.id, "/post.txt", ["title"]);
      // fields is a no-op on the string path: still a full entry
      expect(entry.title).toEqual("Full");
      expect(typeof entry.html).toEqual("string");
    });
  });

  describe("hash path (readEntriesFromHash on)", function () {
    var previous;
    beforeEach(function () {
      previous = config.redis.readEntriesFromHash;
      config.redis.readEntriesFromHash = true;
    });
    afterEach(function () {
      config.redis.readEntriesFromHash = previous;
    });

    it("returns a whole entry from the hash", async function () {
      await this.set("/post.txt", "# Hello\n\nthe body");

      var entry = await get(this.blog.id, "/post.txt");

      expect(entry.path).toEqual("/post.txt");
      expect(entry.title).toEqual("Hello");
      expect(typeof entry.html).toEqual("string");
      expect(entry.html.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tags)).toBe(true);
    });

    it("returns a single field as a scalar for a single entry", async function () {
      await this.set("/post.txt", "# Scalar title\n\nbody");

      var title = await get(this.blog.id, "/post.txt", "title");

      expect(title).toEqual("Scalar title");
    });

    it("returns only the requested fields (plus id) for an array of fields", async function () {
      await this.set("/post.txt", "# Narrow\n\nbody text");

      var entry = await get(this.blog.id, "/post.txt", ["title", "url"]);

      expect(entry.title).toEqual("Narrow");
      expect(entry.id).toEqual("/post.txt");
      expect("html" in entry).toBe(false);
      expect("body" in entry).toBe(false);
    });

    it("narrows a list of entries", async function () {
      await this.set("/a.txt", "# Alpha\n\naaa");
      await this.set("/b.txt", "# Beta\n\nbbb");

      var entries = await get(this.blog.id, ["/a.txt", "/b.txt"], ["title"]);

      expect(entries.length).toEqual(2);
      entries.forEach(function (entry) {
        expect(typeof entry.title).toEqual("string");
        expect("html" in entry).toBe(false);
      });
    });

    it("keeps id on a multi-entry single-field read so results stay correlatable", async function () {
      await this.set("/a.txt", "# Alpha\n\naaa");
      await this.set("/b.txt", "# Beta\n\nbbb");

      var entries = await get(this.blog.id, ["/a.txt", "/b.txt"], "title");

      expect(entries.length).toEqual(2);
      entries.forEach(function (entry) {
        expect(typeof entry.title).toEqual("string");
        expect(typeof entry.id).toEqual("string");
      });
    });

    it("falls back to the legacy JSON string key when the hash is missing", async function () {
      await this.set("/legacy.txt", "# Legacy\n\nold entry");

      // Simulate an entry that predates the hash dual-write.
      await redis.del(key.entryHash(this.blog.id, "/legacy.txt"));

      var whole = await get(this.blog.id, "/legacy.txt");
      expect(whole.title).toEqual("Legacy");
      expect(whole.html.length).toBeGreaterThan(0);

      var title = await get(this.blog.id, "/legacy.txt", "title");
      expect(title).toEqual("Legacy");
    });

    it("projects the JSON-string fallback down to the requested fields", async function () {
      await this.set("/legacy.txt", "# Legacy\n\nheavy body here");
      await redis.del(key.entryHash(this.blog.id, "/legacy.txt"));

      var entry = await get(this.blog.id, "/legacy.txt", ["title", "url"]);

      expect(entry.title).toEqual("Legacy");
      expect(entry.id).toEqual("/legacy.txt");
      expect("html" in entry).toBe(false);
      expect("body" in entry).toBe(false);
    });

    it("returns undefined for a missing single entry", async function () {
      var entry = await get(this.blog.id, "/does-not-exist.txt");

      expect(entry).toBeUndefined();
    });

    it("returns an empty array for an empty list", async function () {
      var entries = await get(this.blog.id, []);

      expect(entries).toEqual([]);
    });
  });
});
