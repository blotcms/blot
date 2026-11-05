describe("models/file", function () {
  var File = require("models/file");
  var client = require("models/client");

  // A blog, so blog deletion sweeps the index away afterwards
  global.test.blog();

  var MODIFIED = 1700000000000;
  var SHA1 = "a".repeat(40);

  function file(size, sha1) {
    return { type: "file", size: size, modified: MODIFIED, sha1: sha1 || SHA1 };
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
  }

  async function collect(iterator) {
    var found = [];
    for await (var item of iterator) found.push(item);
    return found;
  }

  function names(entries) {
    return entries.map(function (entry) {
      return entry.name;
    });
  }

  // Every name of a directory, a page of limit at a time
  async function pages(blogID, dir, limit) {
    var seen = [];
    var after = null;

    do {
      var page = await File.list(blogID, dir, { after: after, limit: limit });
      seen.push(...names(page.entries));
      after = page.next;
    } while (after !== null);

    return seen;
  }

  describe("set and get", function () {
    it("records a file under the same path as its entry", async function () {
      await File.set(this.blog.id, "posts/a.txt", file(5));

      expect(await File.get(this.blog.id, "/posts/a.txt")).toEqual(file(5));
      expect(await File.get(this.blog.id, "posts/a.txt/")).toEqual(file(5));
    });

    it("normalises names to NFC, as entry keys are", async function () {
      await File.set(this.blog.id, "/Café.txt", file(1));

      expect(await File.get(this.blog.id, "/Café.txt")).toEqual(file(1));
    });

    it("is null for a missing path, and the folder itself is a directory", async function () {
      expect(await File.get(this.blog.id, "/nope")).toBeNull();
      expect((await File.get(this.blog.id, "/")).type).toEqual("dir");
    });

    it("gives every ancestor a directory record", async function () {
      await File.set(this.blog.id, "/a/b/c.txt", file(1));

      expect((await File.get(this.blog.id, "/a")).type).toEqual("dir");
      expect((await File.get(this.blog.id, "/a/b")).type).toEqual("dir");
      expect(await collect(File.subtree(this.blog.id, "/"))).toEqual(["/a", "/a/b", "/a/b/c.txt"]);
    });

    it("keeps an ancestor's own record when it already has one", async function () {
      await File.set(this.blog.id, "/a", { type: "dir", modified: 5 });
      await File.set(this.blog.id, "/a/b.txt", file(1));

      expect((await File.get(this.blog.id, "/a")).modified).toEqual(5);
    });

    it("records a directory with no size or hash", async function () {
      await File.set(this.blog.id, "/d", { type: "dir", size: 9, modified: MODIFIED, sha1: SHA1 });

      expect(await File.get(this.blog.id, "/d")).toEqual({ type: "dir", size: 0, modified: MODIFIED, sha1: "" });
    });

    it("refuses anything below a file, a file over a directory and a directory over a file", async function () {
      await File.set(this.blog.id, "/f", file(1));
      await File.set(this.blog.id, "/d", { type: "dir", modified: MODIFIED });

      expect((await rejection(File.set(this.blog.id, "/f/g", file(1)))).code).toEqual("ENOTDIR");
      expect((await rejection(File.set(this.blog.id, "/d", file(1)))).code).toEqual("EISDIR");
      expect((await rejection(File.set(this.blog.id, "/f", { type: "dir" }))).code).toEqual("EEXIST");
      expect(await File.get(this.blog.id, "/f/g")).toBeNull();
    });

    it("refuses the folder itself and a bad record", async function () {
      expect(await rejection(File.set(this.blog.id, "/", file(1)))).toBeDefined();
      expect(await rejection(File.set(this.blog.id, "/x", { type: "link" }))).toBeDefined();
      expect(await rejection(File.set(this.blog.id, "/x", file(1, "not hex")))).toBeDefined();
    });

    it("stores names with the separator and other awkward characters", async function () {
      var name = "/a|b|c ☕\tline\n.txt";

      await File.set(this.blog.id, name, file(3));

      expect(await File.get(this.blog.id, name)).toEqual(file(3));
      expect(names(await File.listAll(this.blog.id, "/"))).toEqual([name.slice(1)]);
    });

    it("keeps no key per file", async function () {
      for (var i = 0; i < 20; i++) await File.set(this.blog.id, "/d/" + i, file(1));

      var keys = [];

      for await (var key of client.scanIterator({ MATCH: "blog:" + this.blog.id + ":file*" })) {
        keys.push(...(Array.isArray(key) ? key : [key]));
      }

      // A hash, a lowercased lookup and a names set each for "/" and "/d",
      // the path set and the totals
      expect(keys.length).toEqual(8);
    });
  });

  describe("totals", function () {
    it("counts files and bytes, replacing and removing", async function () {
      await File.set(this.blog.id, "/a.txt", file(10));
      await File.set(this.blog.id, "/d/b.txt", file(5));
      await File.set(this.blog.id, "/a.txt", file(3));

      expect(await File.totals(this.blog.id)).toEqual({ bytes: 8, files: 2 });

      await File.remove(this.blog.id, "/a.txt");

      expect(await File.totals(this.blog.id)).toEqual({ bytes: 5, files: 1 });
    });

    it("is zero for an empty folder", async function () {
      expect(await File.totals(this.blog.id)).toEqual({ bytes: 0, files: 0 });
    });
  });

  describe("list", function () {
    it("pages a directory with a cursor and lists all of it sorted", async function () {
      for (var i = 0; i < 30; i++) await File.set(this.blog.id, "/d/" + String(i).padStart(2, "0"), file(1));

      var seen = await pages(this.blog.id, "/d", 7);

      expect(seen).toEqual(names(await File.listAll(this.blog.id, "/d")));
      expect(seen.length).toEqual(30);
      expect(seen.slice(0, 3)).toEqual(["00", "01", "02"]);
    });

    describe("a large directory", function () {
      // Names which sort differently by code unit and by UTF-8 byte (from
      // U+E000 up, against characters beyond U+FFFF), and some ASCII edges
      var AWKWARD = ["！ wide", "�", "", "\u{1F600} smile", "\u{10FFFF}", "\u{10000}", "Zed", "a b", "a|b", "[x", "(y", "-", "+"];

      // A directory of a few thousand files and a hundred subdirectories,
      // each with files of its own, so the path set interleaves them
      beforeEach(async function () {
        var items = [];

        for (var i = 0; i < 3000; i++) items.push(Object.assign({ path: "/big/f" + String(i).padStart(4, "0") }, file(1)));

        for (var j = 0; j < 100; j++) {
          for (var k = 0; k < 3; k++) {
            items.push(Object.assign({ path: "/big/s" + String(j).padStart(3, "0") + "/x" + k }, file(1)));
          }
        }

        for (var name of AWKWARD) items.push(Object.assign({ path: "/big/" + name }, file(1)));

        for (var n = 0; n < items.length; n += 500) await File.setMany(this.blog.id, items.slice(n, n + 500));

        this.expected = items
          .map(function (item) {
            return item.path.split("/")[2];
          })
          .filter(function (name, i, all) {
            return all.indexOf(name) === i;
          })
          .sort();
      });

      it("pages in code-unit order, with no duplicate and no gap across cursors", async function () {
        expect(this.expected.length).toEqual(3000 + 100 + AWKWARD.length);
        expect(await pages(this.blog.id, "/big", 97)).toEqual(this.expected);
        expect(names(await File.listAll(this.blog.id, "/big"))).toEqual(this.expected);

        var sizes = [];
        var seen = [];

        for await (var page of File.pages(this.blog.id, "/big", { limit: 1000 })) {
          sizes.push(page.length);
          seen.push(...names(page));
        }

        expect(seen).toEqual(this.expected);
        expect(sizes).toEqual([1000, 1000, 1000, this.expected.length - 3000]);
      });

      it("reads only the page's names from the directory's hash", async function () {
        spyOn(client, "hScan").and.callThrough();
        spyOn(client, "hmGet").and.callThrough();

        var page = await File.list(this.blog.id, "/big", { limit: 10 });

        expect(names(page.entries)).toEqual(this.expected.slice(0, 10));
        expect(page.next).toEqual(this.expected[9]);
        expect(client.hScan).not.toHaveBeenCalled();
        expect(client.hmGet.calls.mostRecent().args[1].length).toEqual(10);
      });

      it("sees writes and removes made between pages", async function () {
        var blogID = this.blog.id;
        var first = await File.list(blogID, "/big", { limit: 100 });
        var seen = names(first.entries);

        // f0050 was listed, f2000 not yet; s050 is a subdirectory to come
        await File.remove(blogID, "/big/f0050");
        await File.remove(blogID, "/big/f2000");
        await File.remove(blogID, "/big/s050");
        await File.set(blogID, "/big/a-before", file(1));
        await File.set(blogID, "/big/f2000b", file(1));
        await File.set(blogID, "/big/new/deep.txt", file(1));

        var after = first.next;

        do {
          var page = await File.list(blogID, "/big", { after: after, limit: 100 });
          seen.push(...names(page.entries));
          after = page.next;
        } while (after !== null);

        var expected = this.expected
          .filter(function (name) {
            return name !== "f2000" && name !== "s050";
          })
          .concat("f2000b", "new")
          .sort();

        // f0050 was listed before it went, and a-before sorts before the
        // cursor, so neither is seen again
        expect(seen).toEqual(expected);
        expect(names(await File.listAll(blogID, "/big"))).toEqual(
          expected.filter((name) => name !== "f0050").concat("a-before").sort()
        );
      });

      it("ends at a cursor after the last entry, and resumes after an entry removed since", async function () {
        var last = this.expected[this.expected.length - 1];

        expect(await File.list(this.blog.id, "/big", { after: last })).toEqual({ entries: [], next: null });

        await File.remove(this.blog.id, "/big/f0100");

        var page = await File.list(this.blog.id, "/big", { after: "f0100", limit: 2 });

        expect(names(page.entries)).toEqual(["f0101", "f0102"]);
        expect(page.next).toEqual("f0102");
      });
    });

    it("has no cursor after a last page which is exactly full", async function () {
      for (var i = 0; i < 4; i++) await File.set(this.blog.id, "/d/" + i, file(1));

      expect((await File.list(this.blog.id, "/d", { limit: 4 })).next).toBeNull();
      expect((await File.list(this.blog.id, "/d", { limit: 3 })).next).toEqual("2");
      expect(await File.list(this.blog.id, "/d", { after: "2", limit: 3 })).toEqual({
        entries: [Object.assign({ name: "3" }, file(1))],
        next: null,
      });
    });

    describe("a directory without a names set", function () {
      // As a directory last changed before names sets existed is stored
      async function forget(blogID, dir) {
        await client.del(File.key.names(blogID, dir));
      }

      beforeEach(async function () {
        var items = [];

        for (var i = 0; i < 1200; i++) items.push(Object.assign({ path: "/old/" + String(i).padStart(4, "0") }, file(1)));

        items.push(Object.assign({ path: "/old/！" }, file(1)), Object.assign({ path: "/old/\u{1F600}" }, file(1)));
        items.push(Object.assign({ path: "/old/sub/a" }, file(1)));

        for (var n = 0; n < items.length; n += 500) await File.setMany(this.blog.id, items.slice(n, n + 500));

        this.expected = names(await File.listAll(this.blog.id, "/old"));

        await forget(this.blog.id, "/old");
        await forget(this.blog.id, "/old/sub");
        await forget(this.blog.id, "/");
      });

      it("still lists in order, reading the hash whole", async function () {
        expect(this.expected.length).toEqual(1203);
        expect(this.expected.slice(-2)).toEqual(["\u{1F600}", "！"]);
        expect(await pages(this.blog.id, "/old", 101)).toEqual(this.expected);
        expect(await File.list(this.blog.id, "/old", { after: this.expected[1202] })).toEqual({ entries: [], next: null });
        expect(names(await File.listAll(this.blog.id, "/old"))).toEqual(this.expected);
        expect(await client.exists(File.key.names(this.blog.id, "/old"))).toEqual(0);
      });

      it("gets a complete names set from its first new name, and keeps it through removes", async function () {
        await File.set(this.blog.id, "/old/0600x", file(1));
        await File.remove(this.blog.id, "/old/0000");
        await File.remove(this.blog.id, "/old/sub");

        var expected = this.expected
          .filter((name) => name !== "0000" && name !== "sub")
          .concat("0600x")
          .sort();

        expect(await client.zCard(File.key.names(this.blog.id, "/old"))).toEqual(expected.length);
        expect(await pages(this.blog.id, "/old", 101)).toEqual(expected);
      });

      it("changing an existing name, or removing one, builds nothing", async function () {
        await File.set(this.blog.id, "/old/0001", file(2));
        await File.remove(this.blog.id, "/old/0002");

        expect(await client.exists(File.key.names(this.blog.id, "/old"))).toEqual(0);
        expect(await pages(this.blog.id, "/old", 500)).toEqual(this.expected.filter((name) => name !== "0002"));
      });

      it("is given one by addMissingNames, which only counts without apply", async function () {
        expect(await File.addMissingNames(this.blog.id)).toEqual({ dirs: 3, missing: 3, names: 1205 });
        expect(await client.exists(File.key.names(this.blog.id, "/old"))).toEqual(0);

        expect(await File.addMissingNames(this.blog.id, { apply: true })).toEqual({ dirs: 3, missing: 3, names: 1205 });
        expect(await File.addMissingNames(this.blog.id)).toEqual({ dirs: 3, missing: 0, names: 0 });

        spyOn(client, "hScan").and.callThrough();

        expect(await pages(this.blog.id, "/old", 101)).toEqual(this.expected);
        expect(client.hScan).not.toHaveBeenCalled();
      });
    });

    it("gives each entry's record", async function () {
      await File.set(this.blog.id, "/d/a.txt", file(4));
      await File.set(this.blog.id, "/d/sub", { type: "dir", modified: MODIFIED });

      expect(await File.listAll(this.blog.id, "/d")).toEqual([
        Object.assign({ name: "a.txt" }, file(4)),
        { name: "sub", type: "dir", size: 0, modified: MODIFIED, sha1: "" },
      ]);
    });

    it("is null for a missing directory or a file, and empty for an empty one", async function () {
      await File.set(this.blog.id, "/f", file(1));
      await File.set(this.blog.id, "/empty", { type: "dir", modified: MODIFIED });

      expect(await File.list(this.blog.id, "/nope")).toBeNull();
      expect(await File.listAll(this.blog.id, "/f")).toBeNull();
      expect(await File.listAll(this.blog.id, "/empty")).toEqual([]);
      expect(await File.listAll(this.blog.id, "/")).toEqual(jasmine.any(Array));
    });
  });

  describe("subtree", function () {
    it("yields every path below a directory, a page at a time, and nothing beside it", async function () {
      await File.set(this.blog.id, "/a/1", file(1));
      await File.set(this.blog.id, "/a/b/2", file(1));
      await File.set(this.blog.id, "/a b", file(1));
      await File.set(this.blog.id, "/a0", file(1));
      await File.set(this.blog.id, "/ab/3", file(1));

      expect(await collect(File.subtree(this.blog.id, "/a", { pageSize: 2 }))).toEqual(["/a/1", "/a/b", "/a/b/2"]);
      expect((await collect(File.subtree(this.blog.id, "/"))).length).toEqual(8);
      expect(await collect(File.subtree(this.blog.id, "/nope"))).toEqual([]);
    });
  });

  describe("resolveCaseInsensitive", function () {
    it("finds the stored spelling of each segment", async function () {
      await File.set(this.blog.id, "/Templates/Style.CSS", file(1));

      expect(await File.resolveCaseInsensitive(this.blog.id, "/templates/style.css")).toEqual("/Templates/Style.CSS");
      expect(await File.resolveCaseInsensitive(this.blog.id, "/")).toEqual("/");
      expect(await File.resolveCaseInsensitive(this.blog.id, "/nope")).toBeNull();
      expect(await File.resolveCaseInsensitive(this.blog.id, "/templates/style.css/x")).toBeNull();
    });

    it("keeps two names which differ only by case, the exact one first", async function () {
      await File.set(this.blog.id, "/templates/a", file(1));
      await File.set(this.blog.id, "/Templates/b", file(1));

      expect(await File.resolveCaseInsensitive(this.blog.id, "/templates/a")).toEqual("/templates/a");
      expect(await File.resolveCaseInsensitive(this.blog.id, "/Templates/b")).toEqual("/Templates/b");
      // Neither is exact: the first in sorted order
      expect(await File.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/b")).toEqual("/Templates/b");
      // Each segment is resolved on its own, with no going back to try a
      // sibling, as helper/caseSensitivePath does
      expect(await File.resolveCaseInsensitive(this.blog.id, "/Templates/a")).toBeNull();
    });

    it("forgets a name once it is removed, keeping its case-only sibling", async function () {
      await File.set(this.blog.id, "/Templates/a", file(1));
      await File.set(this.blog.id, "/templates/a", file(1));

      await File.remove(this.blog.id, "/Templates");

      expect(await File.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/A")).toEqual("/templates/a");

      await File.remove(this.blog.id, "/templates");

      expect(await File.resolveCaseInsensitive(this.blog.id, "/TEMPLATES/A")).toBeNull();
    });

    it("folds case beyond ASCII, across Unicode normalisation", async function () {
      await File.set(this.blog.id, "/ÉTÉ/Café.txt", file(1));

      expect(await File.resolveCaseInsensitive(this.blog.id, "/été/CAFÉ.TXT")).toEqual("/ÉTÉ/Café.txt");
    });
  });

  describe("remove", function () {
    it("removes a file and resolves to its record, or null when there was none", async function () {
      await File.set(this.blog.id, "/d/a.txt", file(2));

      expect(await File.remove(this.blog.id, "/d/a.txt")).toEqual(file(2));
      expect(await File.remove(this.blog.id, "/d/a.txt")).toBeNull();
      expect(await File.get(this.blog.id, "/d/a.txt")).toBeNull();
      // The directory stays, as it would on disk
      expect(await File.listAll(this.blog.id, "/d")).toEqual([]);
    });

    it("removes a directory's whole subtree from every structure", async function () {
      for (var i = 0; i < 25; i++) await File.set(this.blog.id, "/d/" + (i % 5) + "/f" + i, file(2));
      await File.set(this.blog.id, "/d0", file(7));
      await File.set(this.blog.id, "/d/Sub/x", file(1));

      await File.remove(this.blog.id, "/d");

      expect(await File.get(this.blog.id, "/d")).toBeNull();
      expect(await File.get(this.blog.id, "/d/0/f0")).toBeNull();
      expect(await File.resolveCaseInsensitive(this.blog.id, "/D/sub/x")).toBeNull();
      expect(await collect(File.subtree(this.blog.id, "/"))).toEqual(["/d0"]);
      expect(await File.totals(this.blog.id)).toEqual({ bytes: 7, files: 1 });

      var keys = [];

      for await (var key of client.scanIterator({ MATCH: "blog:" + this.blog.id + ":file:*:/d/*" })) {
        keys.push(...(Array.isArray(key) ? key : [key]));
      }

      expect(keys).toEqual([]);
    });

    it("refuses to remove the folder itself", async function () {
      expect(await rejection(File.remove(this.blog.id, "/"))).toBeDefined();
    });
  });

  describe("removeAll", function () {
    it("forgets everything", async function () {
      await File.set(this.blog.id, "/a/b/c", file(1));
      await File.set(this.blog.id, "/d", file(1));

      await File.removeAll(this.blog.id);

      expect(await collect(File.subtree(this.blog.id, "/"))).toEqual([]);
      expect(await File.listAll(this.blog.id, "/")).toEqual([]);
      expect(await File.totals(this.blog.id)).toEqual({ bytes: 0, files: 0 });
      expect(await File.resolveCaseInsensitive(this.blog.id, "/A")).toBeNull();
    });
  });

  describe("rebuild", function () {
    it("replaces the index with a listing, inferring directories", async function () {
      await File.set(this.blog.id, "/stale.txt", file(100));

      async function* listing() {
        yield { path: "/a/b.txt", type: "file", size: 3, modified: MODIFIED, sha1: SHA1 };
        yield { path: "/empty", type: "dir", size: 0, modified: MODIFIED };
        yield { path: "/c.txt", type: "file", size: 4, modified: MODIFIED, sha1: "" };
      }

      expect(await File.rebuild(this.blog.id, listing())).toEqual({ files: 2, dirs: 2, bytes: 7, skipped: [] });
      expect(await File.get(this.blog.id, "/stale.txt")).toBeNull();
      expect(await collect(File.subtree(this.blog.id, "/"))).toEqual(["/a", "/a/b.txt", "/c.txt", "/empty"]);
      expect(await File.get(this.blog.id, "/c.txt")).toEqual(Object.assign(file(4), { sha1: "" }));
    });

    it("skips records which conflict with one before them, and reports them", async function () {
      var records = [
        { path: "/a", type: "file", size: 1, modified: MODIFIED },
        { path: "/a/b.txt", type: "file", size: 2, modified: MODIFIED },
        { path: "/a", type: "dir", size: 0, modified: MODIFIED },
        { path: "/c.txt", type: "file", size: 4, modified: MODIFIED },
        { path: "/d", type: "dir", size: 0, modified: MODIFIED },
        { path: "/d", type: "file", size: 8, modified: MODIFIED },
      ];

      var counts = await File.rebuild(this.blog.id, records);

      expect(counts.skipped).toEqual([
        { path: "/a/b.txt", type: "file", code: "ENOTDIR" },
        { path: "/a", type: "dir", code: "EEXIST" },
        { path: "/d", type: "file", code: "EISDIR" },
      ]);
      expect(counts.files).toEqual(2);
      expect(counts.bytes).toEqual(5);
      expect((await File.get(this.blog.id, "/a")).type).toEqual("file");
      expect((await File.get(this.blog.id, "/d")).type).toEqual("dir");
    });

    it("takes more records than one batch", async function () {
      var records = [];

      for (var i = 0; i < 1201; i++) records.push({ path: "/d/" + i, type: "file", size: 1, modified: MODIFIED });

      expect(await File.rebuild(this.blog.id, records)).toEqual({ files: 1201, dirs: 1, bytes: 1201, skipped: [] });
      expect((await File.listAll(this.blog.id, "/d")).length).toEqual(1201);
    });
  });
});
