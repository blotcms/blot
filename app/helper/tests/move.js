describe("move ", function () {
  const move = require("../move");
  const { suffixer } = move;
  const is = require("./util/is")(function (path) {
    const { destination } = suffixer(path);
    return destination;
  });
  const fs = require("fs-extra");
  const { join } = require("path");

  const os = require("os");

  // The helper moves things inside a directory on disk, so give it a
  // temporary directory of its own
  beforeEach(async function () {
    this.directory = await fs.mkdtemp(join(os.tmpdir(), "blot-move-"));
  });

  afterEach(async function () {
    await fs.remove(this.directory);
  });

  it("moves a file", async function () {
    await this.check([{ from: "/foo.txt", to: "/bar.txt" }]);
  });

  it("returns suffix and destination", function () {
    expect(suffixer("/foo.txt")).toEqual({
      destination: "/foo copy.txt",
      suffix: " copy",
      name: "foo",
      extension: ".txt",
    });
    expect(suffixer("/foo copy.txt")).toEqual({
      destination: "/foo copy 2.txt",
      suffix: " copy 2",
      name: "foo",
      extension: ".txt",
    });
    expect(suffixer("/foo copy 2.txt")).toEqual({
      destination: "/foo copy 3.txt",
      suffix: " copy 3",
      name: "foo",
      extension: ".txt",
    });
  });

  it("suffixes a path correctly", function () {
    const dir = global.test.fake.path();

    // appends 'copy' to filename after extension
    is(join(dir, "foo.txt"), join(dir, "foo copy.txt"));
    is(join(dir, "foo.index.txt"), join(dir, "foo.index copy.txt"));
    is(join(dir, "foocopy.txt"), join(dir, "foocopy copy.txt"));
    is(join(dir, "foo c.txt"), join(dir, "foo c copy.txt"));
    is(join(dir, "foo 1.txt"), join(dir, "foo 1 copy.txt"));
    is(join(dir, "foo copy1.txt"), join(dir, "foo copy1 copy.txt"));
    is(join(dir, "foo copy .txt"), join(dir, "foo copy  copy.txt"));
    is(join(dir, "foo Copy.txt"), join(dir, "foo Copy copy.txt"));

    // appends 'copy 2' to filenames ending in ' copy' after extension
    is(join(dir, "foo copy.txt"), join(dir, "foo copy 2.txt"));
    is(join(dir, "foo Copy copy.txt"), join(dir, "foo Copy copy 2.txt"));

    // appends 'copy ${n+1}' to filenames ending in 'copy ${n}'
    is(join(dir, "foo copy 2.txt"), join(dir, "foo copy 3.txt"));
    is(join(dir, "foo copy 20000.txt"), join(dir, "foo copy 20001.txt"));
    is(join(dir, "foo Copy copy 9.txt"), join(dir, "foo Copy copy 10.txt"));

    // does not mess with path
    is("foo.txt", "foo copy.txt");
    is(":/foo.txt", ":/foo copy.txt");

    // does replace double slashes
    is("bar//foo.txt", "bar/foo copy.txt");

    // does not mess with whitespace
    is(" foo.txt", " foo copy.txt");
    is(" foo .txt ", " foo  copy.txt ");
  });

  it("doesn't throw with random paths", function () {
    const iterations = 10000;

    function runTest(path) {
      let result;
      expect(function () {
        result = suffixer(path);
      }).not.toThrow();
      expect(typeof result.destination).toBe("string");
    }

    for (var i = 0; i < iterations; i++) {
      runTest(global.test.fake.path());
    }
  });

  it("moves many files", async function () {
    await this.check([
      { from: "/Foo/A/b.txt", to: "/Bar/A/b.txt" },
      { from: "/Foo/B/c.txt", to: "/Bar/B/c.txt" },
      { from: "/Foo/C/d.txt", to: "/Bar/C/d.txt" },
      { from: "/Foo/D/e.txt", to: "/Bar/D/e.txt" },
    ]);
  });

  it("moves a folder", async function () {
    await this.check([{ from: "/foo", to: "/bar" }], { folders: ["/bar"] });
  });

  it("moves case-conflicting files", async function () {
    await this.check([
      { from: "/foO.txt", to: "/foo.txt" },
      { from: "/FOO.txt", to: "/foO.txt" },
    ]);
  });

  it("moves a folder and resolves conflicts", async function () {
    await this.check(
      [
        { from: "/foo", to: "/bat" },
        { from: "/bar", to: "/bat", result: "/bat copy" },
        { from: "/baz", to: "/bat", result: "/bat copy 2" },
      ],
      { folders: ["/bat", "/bat copy", "/bat copy 2"] }
    );
  });

  it("moves a folder in a folder and resolves conflicts", async function () {
    await this.check(
      [
        { from: "/foo/bar/baz", to: "/bar/bat" },
        { from: "/bat/baz/boo", to: "/bar/bat", result: "/bar/bat copy" },
      ],
      {
        folders: [
          "/bar",
          "/bar/bat",
          "/bar/bat copy",
          "/bat",
          "/bat/baz",
          "/foo",
          "/foo/bar",
        ],
      }
    );
  });

  it("moves a file into a folder", async function () {
    await this.check([{ from: "/foo.txt", to: "/bar/Baz.txt" }]);
  });

  it("moves a file and resolves a conflict", async function () {
    await this.check([
      { from: "/foo.txt", to: "/bar.txt" },
      { from: "/baz.txt", to: "/bar.txt", result: "/bar copy.txt" },
    ]);
  });

  it("moves a file and resolves many conflicts", async function () {
    await this.check([
      { from: "/foo.txt", to: "/bar.txt" },
      { from: "/bat.txt", to: "/bar.txt", result: "/bar copy.txt" },
      { from: "/baz.txt", to: "/bar.txt", result: "/bar copy 2.txt" },
      { from: "/bac.txt", to: "/bar.txt", result: "/bar copy 3.txt" },
    ]);
  });

  it("moves a file into a folder that already exists", async function () {
    await this.check([
      { from: "/Bar/baz.txt", to: "/Bar/foo.txt" },
      { from: "/foo.txt", to: "/Bar/Bat.txt" },
    ]);
  });

  beforeEach(function () {
    this.check = async (items, { folders } = {}) => {
      const base = this.directory;
      const results = {};
      const initialContents = {};

      // create the files
      for (const { from, contents = global.test.fake.file() } of items) {
        if (from.includes(".")) {
          await fs.outputFile(join(base, from), contents);
          initialContents[from] = contents;
        } else {
          await fs.ensureDir(join(base, from));
        }
      }

      for (const { from, to } of items) {
        const result = await move(base, from, to);
        results[from] = result.destination;
      }

      const fileList = allFiles(base).sort();

      for (const { from, to, result } of items) {
        if (from.includes(".")) continue;
        if (result && to !== result) {
          expect(fs.statSync(join(base, result)).isDirectory()).toEqual(true);
          expect(fs.statSync(join(base, to)).isDirectory()).toEqual(true);
        } else {
          expect(fs.statSync(join(base, to)).isDirectory()).toEqual(true);
        }
        expect(fs.existsSync(join(base, from))).toEqual(false);
      }

      if (folders) {
        const folderList = allFolders(base).sort();
        expect(folders.sort()).toEqual(folderList);
      }

      expect(fileList).toEqual(
        items
          .filter(({ from }) => from.includes("."))
          .map(({ to, result }) => result || to)
          .sort()
      );

      expect(fileList).toEqual(
        Object.values(results)
          .filter((result) => result.includes("."))
          .sort()
      );

      items.forEach(({ to, from }) => {
        if (from.includes(".")) {
          const contents = fs.readFileSync(join(base, results[from]), "utf-8");
          expect(contents).toEqual(initialContents[from]);
        }
      });
    };
  });

  function allFiles(base, path = "/") {
    var results = [];
    var list = fs.readdirSync(join(base, path));
    list.forEach(function (file) {
      file = join(path, file);
      var stat = fs.statSync(join(base, file));
      if (stat && stat.isDirectory()) {
        /* Recurse into a subdirectory */
        results = results.concat(allFiles(base, file));
      } else {
        results.push(file);
        /* Is a file */
      }
    });
    return results;
  }

  function allFolders(base, path = "/") {
    var results = [];
    var list = fs.readdirSync(join(base, path));
    list.forEach(function (file) {
      file = join(path, file);
      var stat = fs.statSync(join(base, file));
      if (stat && stat.isDirectory()) {
        /* Recurse into a subdirectory */
        results = results.concat(allFolders(base, file));
        results.push(file);
      } else {
        /* Is a file */
      }
    });
    return results;
  }
});
