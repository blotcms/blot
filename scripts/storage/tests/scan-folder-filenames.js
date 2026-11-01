describe("scripts/storage/scan-folder-filenames", function () {
  var fs = require("fs-extra");
  var os = require("os");
  var join = require("path").join;
  var {
    classifyName,
    classifyDirectory,
    scanFolder,
    display,
  } = require("../scan-folder-filenames");

  function classify(name, keyBytes) {
    return classifyName(Buffer.from(name), keyBytes || 20);
  }

  it("accepts ordinary names", function () {
    expect(classify("post.md")).toEqual([]);
    expect(classify(".htaccess")).toEqual([]);
    expect(classify("Café — notes (1).txt")).toEqual([]);
  });

  it("flags keys over 1024 bytes", function () {
    expect(classify("a", 1024)).toEqual([]);
    expect(classify("a", 1025)).toEqual(["key-too-long"]);
  });

  it("flags names which are not valid UTF-8", function () {
    expect(classifyName(Buffer.from([0x61, 0xff, 0x62]), 20)).toEqual([
      "invalid-utf8",
    ]);
  });

  it("flags control characters, edge whitespace, trailing dots and double spaces", function () {
    expect(classify("a\nb")).toEqual(["control-char"]);
    expect(classify("a\u0085b")).toEqual(["control-char"]);
    expect(classify(" a")).toEqual(["edge-whitespace"]);
    expect(classify("a ")).toEqual(["edge-whitespace"]);
    expect(classify("a.")).toEqual(["trailing-dot"]);
    expect(classify("a  b")).toEqual(["double-space"]);
  });

  it("keeps a leading byte order mark rather than stripping it", function () {
    expect(classifyName(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 20)).toEqual([
      "edge-whitespace",
    ]);
  });

  it("flags dot-only names and slash lookalikes", function () {
    expect(classify("..")).toContain("dot-segment");
    expect(classify("...")).toContain("dot-segment");
    expect(classify(". ")).toContain("dot-segment");
    expect(classify("a\\b")).toEqual(["slash-like"]);
    expect(classify("a／")).toEqual(["slash-like"]);
  });

  it("finds names which differ only by normalisation or case within a directory", function () {
    var names = [
      Buffer.from("café.md"),
      Buffer.from("café.md"),
      Buffer.from("Photo.JPG"),
      Buffer.from("photo.jpg"),
      Buffer.from("other.md"),
    ];
    var found = classifyDirectory(names);

    expect(found.get(0)).toEqual(["nfc-collision"]);
    expect(found.get(1)).toEqual(["nfc-collision"]);
    expect(found.get(2)).toEqual(["case-collision"]);
    expect(found.get(3)).toEqual(["case-collision"]);
    expect(found.has(4)).toBe(false);
  });

  it("escapes control characters and invalid bytes in the report", function () {
    expect(display(Buffer.from("a\tb"))).toBe("a\\u0009b");
    expect(display(Buffer.from([0x61, 0xff]))).toBe("a\\xff");
  });

  describe("scanFolder", function () {
    var root;

    beforeEach(async function () {
      root = await fs.mkdtemp(join(os.tmpdir(), "scan-folder-"));
    });

    afterEach(async function () {
      await fs.remove(root);
    });

    async function scan(prefixBytes) {
      var seen = [];

      await scanFolder(root, prefixBytes, function (category, path) {
        seen.push(category + " " + path.toString());
      });

      return seen.sort();
    }

    it("reports offenders by path, walks subdirectories and ignores symlinks", async function () {
      await fs.outputFile(join(root, "ok.md"), "x");
      await fs.outputFile(join(root, "sub/trailing.txt."), "x");
      await fs.outputFile(join(root, "sub/ok.md"), "x");
      await fs.outputFile(join(root, "target/ends.txt "), "x");
      await fs.symlink(join(root, "sub"), join(root, "link."));

      expect(await scan(0)).toEqual([
        "edge-whitespace /target/ends.txt ",
        "trailing-dot /link.",
        "trailing-dot /sub/trailing.txt.",
      ]);
    });

    it("marks directories with a trailing slash and counts the key length", async function () {
      await fs.ensureDir(join(root, "dir."));

      expect(await scan(0)).toEqual(["trailing-dot /dir./"]);
      expect(await scan(1024)).toEqual([
        "key-too-long /dir./",
        "trailing-dot /dir./",
      ]);
    });
  });
});
