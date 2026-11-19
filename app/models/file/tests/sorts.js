// The natural-order sorted sets beside each directory's names set (sorts.js,
// key.sortMember): the order itself, how every writer keeps them complete,
// and checkSorts, which finds and rebuilds the ones that are not
describe("models/file sorted sets", function () {
  var File = require("models/file");
  var key = require("models/file/key");
  var client = require("models/client");
  var alphanum = require("helper/alphanum");

  global.test.blog();

  var MODIFIED = 1700000000000;

  function file() {
    return { type: "file", size: 1, modified: MODIFIED, sha1: "" };
  }

  function dir() {
    return { type: "dir", size: 0, modified: MODIFIED, sha1: "" };
  }

  function natural(names) {
    return names
      .map(key.sortMember)
      .sort(key.compareSorted)
      .map(key.nameOfSorted);
  }

  // The names in a directory's "all" set, in Redis's order
  async function stored(blogID, path) {
    var members = await client.zRange(key.sort(blogID, "all", path), 0, -1);
    return members.map(key.nameOfSorted);
  }

  async function collect(iterator) {
    var found = [];
    for await (var item of iterator) found.push(item);
    return found;
  }

  function states(found) {
    var result = {};
    found.forEach(function (item) {
      result[item.dir] = item.state;
    });
    return result;
  }

  describe("sortMember", function () {
    it("orders names as a file browser does", function () {
      expect(
        natural([
          "Zebra",
          "IMG_10.jpg",
          "apple",
          "IMG_2.jpg",
          ".DS_Store",
          "café",
          "cafe",
          "b.preview.html",
          "10",
          "9",
          "-dash",
        ])
      ).toEqual([
        "9",
        "10",
        "-dash",
        "apple",
        "cafe",
        "café",
        "IMG_2.jpg",
        "IMG_10.jpg",
        "Zebra",
        ".DS_Store",
        "b.preview.html",
      ]);
    });

    it("keeps names which differ only in case in code-unit order", function () {
      expect(natural(["photo", "pHoto", "Photo", "PHOTO"])).toEqual([
        "PHOTO",
        "Photo",
        "pHoto",
        "photo",
      ]);
    });

    it("compares long runs of digits by value, never splitting them", function () {
      expect(
        natural(["1000", "999", "1" + "0".repeat(300), "9".repeat(299)])
      ).toEqual(["999", "1000", "9".repeat(299), "1" + "0".repeat(300)]);
    });

    it("puts more leading zeros first, as the dashboard has", function () {
      expect(natural(["1", "01a", "001", "2"])).toEqual([
        "001",
        "01a",
        "1",
        "2",
      ]);
    });

    it("agrees with the dashboard's order for names without spaces or accents", function () {
      var alphabet = [
        "0",
        "00",
        "1",
        "01",
        "2",
        "10",
        "a",
        "B",
        "x",
        "-",
        "_",
        "(",
        "~",
        ".",
      ];
      var disagreements = [];
      var seed = 7;

      function random(n) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      }

      function name() {
        var result = "";
        for (var i = 0, n = 1 + random(6); i < n; i++)
          result += alphabet[random(alphabet.length)];
        // A leading dot is hidden everywhere, which the dashboard filters out
        return result.replace(/^\.+/, "") || "a";
      }

      for (var i = 0; i < 20000; i++) {
        var a = name();
        var b = name();
        var dashboard = Math.sign(
          alphanum.compare(a, b, { insensitive: true })
        );
        var ours = Math.sign(
          key.compareSorted(key.sortMember(a), key.sortMember(b))
        );

        if (dashboard !== 0 && dashboard !== ours) disagreements.push([a, b]);
      }

      expect(disagreements).toEqual([]);
    });

    it("keeps leading spaces and underscores in the key, so prefixes stay together", function () {
      expect(natural(["b", "_b", " _a", "_a", "a"])).toEqual([
        " _a",
        "_a",
        "_b",
        "a",
        "b",
      ]);
    });

    it("ignores control characters and only the common diacritics", function () {
      expect(key.sortMember("a\u0001b").split("\u0000")[0]).toBe(
        key.sortMember("ab").split("\u0000")[0]
      );
      // Japanese voiced marks are not dropped, so these keep distinct keys
      expect(key.sortMember("が").split("\u0000")[0]).not.toBe(
        key.sortMember("か").split("\u0000")[0]
      );
    });

    it("reads the name back from the member", function () {
      ["a", "IMG_0010.jpg", "café", ".x", "😀 ", "a\u0001b"].forEach(
        function (name) {
          expect(key.nameOfSorted(key.sortMember(name))).toBe(name);
        }
      );
    });

    it("sorts in Redis exactly as compareSorted does", async function () {
      var names = [
        "IMG_10",
        "img_2",
        "Ä",
        "a",
        "😀",
        "",
        "z",
        "_",
        "01",
        "1",
        ".x",
        "x.preview.html",
      ];
      var setKey = key.sort(this.blog.id, "spec", "/");

      await client.zAdd(
        setKey,
        names.map(function (name) {
          return { score: 0, value: key.sortMember(name) };
        })
      );

      var fromRedis = (await client.zRange(setKey, 0, -1)).map(
        key.nameOfSorted
      );

      await client.del(setKey);

      expect(fromRedis).toEqual(natural(names));
    });
  });

  describe("writes", function () {
    it("adds each new child to its directory's set", async function () {
      await File.setMany(this.blog.id, [
        Object.assign({ path: "/Photos/IMG_10.jpg" }, file()),
        Object.assign({ path: "/Photos/IMG_2.jpg" }, file()),
        Object.assign({ path: "/Photos/.DS_Store" }, file()),
        Object.assign({ path: "/a.txt" }, file()),
      ]);

      expect(await stored(this.blog.id, "/Photos")).toEqual([
        "IMG_2.jpg",
        "IMG_10.jpg",
        ".DS_Store",
      ]);
      expect(await stored(this.blog.id, "/")).toEqual(["a.txt", "Photos"]);
    });

    it("writes nothing new for a child which is rewritten", async function () {
      await File.set(this.blog.id, "/a.txt", file());
      await File.set(
        this.blog.id,
        "/a.txt",
        Object.assign(file(), { size: 9 })
      );

      expect(await stored(this.blog.id, "/")).toEqual(["a.txt"]);
    });

    it("refuses a name holding NUL", async function () {
      var err;

      try {
        await File.set(this.blog.id, "/a\u0000b", file());
      } catch (e) {
        err = e;
      }

      expect(err && err.message).toContain("NUL");
    });

    it("builds a directory's set whole on its first new child", async function () {
      await File.setMany(this.blog.id, [
        Object.assign({ path: "/d/b" }, file()),
        Object.assign({ path: "/d/a" }, file()),
      ]);

      // As a directory last changed before the sets existed
      await client.del(key.sort(this.blog.id, "all", "/d"));

      await File.set(this.blog.id, "/d/c", file());

      expect(await stored(this.blog.id, "/d")).toEqual(["a", "b", "c"]);
    });

    it("keeps every child when two writes create a directory at once", async function () {
      // Writers outside the sync lock, as specs and some callers are, can
      // both find the directory new; neither may clear what the other adds
      await Promise.all([
        File.set(this.blog.id, "/d/a", file()),
        File.set(this.blog.id, "/d/b", file()),
        File.set(this.blog.id, "/d/c", file()),
      ]);

      expect(await stored(this.blog.id, "/d")).toEqual(["a", "b", "c"]);
    });

    it("forgets a removed file, and a removed directory's sets", async function () {
      await File.setMany(this.blog.id, [
        Object.assign({ path: "/a" }, file()),
        Object.assign({ path: "/d/e/f" }, file()),
        Object.assign({ path: "/d/g" }, file()),
      ]);

      await File.remove(this.blog.id, "/a");
      await File.remove(this.blog.id, "/d");

      expect(await stored(this.blog.id, "/")).toEqual([]);
      expect(await client.exists(key.sort(this.blog.id, "all", "/d"))).toBe(0);
      expect(await client.exists(key.sort(this.blog.id, "all", "/d/e"))).toBe(
        0
      );
    });

    it("leaves no set behind after removeAll", async function () {
      await File.setMany(this.blog.id, [
        Object.assign({ path: "/a" }, file()),
        Object.assign({ path: "/d/b" }, file()),
      ]);

      await File.removeAll(this.blog.id);

      expect(await client.exists(key.sort(this.blog.id, "all", "/"))).toBe(0);
      expect(await client.exists(key.sort(this.blog.id, "all", "/d"))).toBe(0);
    });

    it("gives a rebuilt index its sets", async function () {
      await File.rebuild(this.blog.id, [
        Object.assign({ path: "/b" }, file()),
        Object.assign({ path: "/A" }, dir()),
        Object.assign({ path: "/A/x10" }, file()),
        Object.assign({ path: "/A/x9" }, file()),
      ]);

      expect(await stored(this.blog.id, "/")).toEqual(["A", "b"]);
      expect(await stored(this.blog.id, "/A")).toEqual(["x9", "x10"]);
    });
  });

  describe("checkSorts", function () {
    beforeEach(async function () {
      await File.setMany(this.blog.id, [
        Object.assign({ path: "/a" }, file()),
        Object.assign({ path: "/d/b" }, file()),
        Object.assign({ path: "/d/c" }, file()),
        Object.assign({ path: "/empty" }, dir()),
      ]);
    });

    it("finds every set complete after the writers above", async function () {
      expect(states(await collect(File.checkSorts(this.blog.id)))).toEqual({
        "/": "ok",
        "/d": "ok",
        "/empty": "ok",
      });
    });

    it("finds a missing set, a short one and one with a stray member", async function () {
      await client.del(key.sort(this.blog.id, "all", "/"));
      await client.zRem(
        key.sort(this.blog.id, "all", "/d"),
        key.sortMember("b")
      );
      await client.zAdd(key.sort(this.blog.id, "all", "/empty"), {
        score: 0,
        value: key.sortMember("gone"),
      });

      expect(states(await collect(File.checkSorts(this.blog.id)))).toEqual({
        "/": "missing",
        "/d": "mismatched",
        "/empty": "mismatched",
      });

      // Without apply nothing changes
      expect(await stored(this.blog.id, "/d")).toEqual(["c"]);
    });

    it("finds a set of the right size holding the wrong member", async function () {
      await client.zRem(
        key.sort(this.blog.id, "all", "/d"),
        key.sortMember("b")
      );
      await client.zAdd(key.sort(this.blog.id, "all", "/d"), {
        score: 0,
        value: key.sortMember("z"),
      });

      expect(states(await collect(File.checkSorts(this.blog.id)))["/d"]).toBe(
        "mismatched"
      );
    });

    it("rebuilds what it finds with apply, leaving no build key", async function () {
      await client.del(key.sort(this.blog.id, "all", "/"));
      await client.zRem(
        key.sort(this.blog.id, "all", "/d"),
        key.sortMember("b")
      );
      await client.zAdd(key.sort(this.blog.id, "all", "/empty"), {
        score: 0,
        value: key.sortMember("gone"),
      });

      await collect(File.checkSorts(this.blog.id, { apply: true }));

      expect(await stored(this.blog.id, "/")).toEqual(["a", "d", "empty"]);
      expect(await stored(this.blog.id, "/d")).toEqual(["b", "c"]);
      expect(await client.exists(key.sort(this.blog.id, "all", "/empty"))).toBe(
        0
      );
      expect(
        await client.exists(key.sortBuild(this.blog.id, "all", "/d"))
      ).toBe(0);
      expect(states(await collect(File.checkSorts(this.blog.id)))).toEqual({
        "/": "ok",
        "/d": "ok",
        "/empty": "ok",
      });
    });

    it("rebuilds a directory larger than a page", async function () {
      var items = [];
      for (var i = 0; i < 2500; i++)
        items.push(Object.assign({ path: "/big/f" + i }, file()));

      await File.setMany(this.blog.id, items);
      await client.del(key.sort(this.blog.id, "all", "/big"));

      await collect(File.checkSorts(this.blog.id, { apply: true }));

      var names = await stored(this.blog.id, "/big");

      expect(names.length).toBe(2500);
      expect(names.slice(0, 3)).toEqual(["f0", "f1", "f2"]);
      expect(names[names.length - 1]).toBe("f2499");
    });

    it("reports sizes for the memory estimate", async function () {
      var found = await collect(File.checkSorts(this.blog.id));
      var d = found.find(function (item) {
        return item.dir === "/d";
      });

      expect(d.expected).toBe(2);
      expect(d.card).toBe(2);
      expect(d.longest).toBe(Buffer.byteLength(key.sortMember("b")));
      expect(d.bytes).toBe(2 * Buffer.byteLength(key.sortMember("b")));
    });

    it("refuses an order it doesn't know", async function () {
      var err;

      try {
        await collect(File.checkSorts(this.blog.id, { order: "nope" }));
      } catch (e) {
        err = e;
      }

      expect(err && err.message).toContain("no such order");
    });
  });
});
