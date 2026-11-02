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

      // A hash and a lowercased lookup each for "/" and "/d", the path set
      // and the totals
      expect(keys.length).toEqual(6);
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

      var seen = [];
      var cursor = null;

      do {
        var page = await File.list(this.blog.id, "/d", { cursor: cursor, limit: 7 });
        seen.push(...names(page.entries));
        cursor = page.cursor;
      } while (cursor);

      expect(seen.sort()).toEqual(names(await File.listAll(this.blog.id, "/d")));
      expect(seen.length).toEqual(30);
      expect(names(await File.listAll(this.blog.id, "/d")).slice(0, 3)).toEqual(["00", "01", "02"]);
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

      expect(await File.rebuild(this.blog.id, listing())).toEqual({ files: 2, dirs: 2, bytes: 7 });
      expect(await File.get(this.blog.id, "/stale.txt")).toBeNull();
      expect(await collect(File.subtree(this.blog.id, "/"))).toEqual(["/a", "/a/b.txt", "/c.txt", "/empty"]);
      expect(await File.get(this.blog.id, "/c.txt")).toEqual(Object.assign(file(4), { sha1: "" }));
    });

    it("takes more records than one batch", async function () {
      var records = [];

      for (var i = 0; i < 1201; i++) records.push({ path: "/d/" + i, type: "file", size: 1, modified: MODIFIED });

      expect(await File.rebuild(this.blog.id, records)).toEqual({ files: 1201, dirs: 1, bytes: 1201 });
      expect((await File.listAll(this.blog.id, "/d")).length).toEqual(1201);
    });
  });
});
