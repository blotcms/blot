var fs = require("fs-extra");
var os = require("os");
var path = require("path");
var determinePath = require("../determine_path");
var write = require("../write");
var createWriter = write.createWriter;

describe("import writer path allocation", function () {
  var output;

  beforeEach(function () {
    output = fs.mkdtempSync(path.join(os.tmpdir(), "import-writer-"));
  });

  afterEach(function () {
    fs.removeSync(output);
  });

  function createAssets(name) {
    var assets = fs.mkdtempSync(path.join(os.tmpdir(), name));
    fs.writeFileSync(path.join(assets, "_image.png"), "image");
    return assets;
  }

  function writeAll(entries, done) {
    var determine = determinePath(output);
    var write = createWriter();
    var index = 0;

    function next(err) {
      if (err) return done.fail(err);
      if (index === entries.length) return done();
      var entry = entries[index++];
      entry.content = entry.content || "body";
      determine(entry, function (err) {
        if (err) return next(err);
        write(entry, next);
      });
    }

    next();
  }

  it("does not reserve paths across standalone default writer calls", function (done) {
    var requestedPath = path.join(output, "name");

    write({ path: requestedPath, content: "first" }, function (err) {
      if (err) return done.fail(err);

      fs.removeSync(path.join(output, "name.txt"));

      write({ path: requestedPath, content: "second" }, function (err) {
        if (err) return done.fail(err);

        expect(fs.readFileSync(path.join(output, "name.txt"), "utf8")).toBe(
          "second"
        );
        expect(fs.existsSync(path.join(output, "name-2.txt"))).toBe(false);
        done();
      });
    });
  });

  it("deduplicates titles which collide after punctuation normalization", function (done) {
    writeAll([{ title: "Hello!" }, { title: "Hello?" }], function () {
      expect(fs.existsSync(path.join(output, "Undated", "Hello.txt"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(output, "Undated", "Hello-2.txt"))).toBe(
        true
      );
      done();
    });
  });

  it("deduplicates names which collide after 150-character truncation", function (done) {
    var prefix = "a".repeat(150);
    writeAll([{ title: prefix + "x" }, { title: prefix + "y" }], function () {
      expect(fs.existsSync(path.join(output, "Undated", prefix + ".txt"))).toBe(
        true
      );
      expect(
        fs.existsSync(
          path.join(output, "Undated", prefix.slice(0, 148) + "-2.txt")
        )
      ).toBe(true);
      done();
    });
  });

  it("keeps suffixes visible within the filename limit", function (done) {
    var entries = [];
    for (var i = 0; i < 10; i++) entries.push({ title: "x".repeat(160) });
    writeAll(entries, function () {
      expect(
        fs.existsSync(path.join(output, "Undated", "x".repeat(147) + "-10.txt"))
      ).toBe(true);
      done();
    });
  });

  it("allows identical names in different destination directories", function (done) {
    writeAll(
      [
        { title: "Same", page: true },
        { title: "Same", draft: true },
      ],
      function () {
        expect(fs.existsSync(path.join(output, "Pages", "Same.txt"))).toBe(
          true
        );
        expect(fs.existsSync(path.join(output, "Drafts", "Same.txt"))).toBe(
          true
        );
        done();
      }
    );
  });

  it("moves staged assets beside the final post.txt", function (done) {
    var assets = fs.mkdtempSync(path.join(os.tmpdir(), "import-assets-"));
    fs.writeFileSync(path.join(assets, "_image.png"), "image");
    writeAll([{ title: "With asset", asset_directory: assets }], function () {
      var destination = path.join(output, "Undated", "With-asset");
      expect(
        fs.readFileSync(path.join(destination, "_image.png"), "utf8")
      ).toBe("image");
      expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
      expect(fs.existsSync(assets)).toBe(false);
      done();
    });
  });

  it("allocates asset-backed posts away from an existing logical directory", function (done) {
    var original = path.join(output, "Undated", "Existing");
    var assets = createAssets("import-assets-existing-dir-");

    fs.ensureDirSync(original);
    fs.writeFileSync(path.join(original, "keep.txt"), "keep");

    writeAll([{ title: "Existing", asset_directory: assets }], function () {
      var destination = path.join(output, "Undated", "Existing-2");

      expect(fs.readFileSync(path.join(original, "keep.txt"), "utf8")).toBe(
        "keep"
      );
      expect(fs.existsSync(path.join(original, "post.txt"))).toBe(false);
      expect(
        fs.readFileSync(path.join(destination, "_image.png"), "utf8")
      ).toBe("image");
      expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
      done();
    });
  });

  it("allocates asset-backed posts away from an existing logical text file", function (done) {
    var assets = createAssets("import-assets-existing-file-");

    fs.ensureDirSync(path.join(output, "Undated"));
    fs.writeFileSync(path.join(output, "Undated", "Existing.txt"), "existing");

    writeAll([{ title: "Existing", asset_directory: assets }], function () {
      var destination = path.join(output, "Undated", "Existing-2");

      expect(
        fs.readFileSync(path.join(output, "Undated", "Existing.txt"), "utf8")
      ).toBe("existing");
      expect(
        fs.readFileSync(path.join(destination, "_image.png"), "utf8")
      ).toBe("image");
      expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
      done();
    });
  });

  it("allocates file-backed posts away from an existing logical directory", function (done) {
    var original = path.join(output, "Undated", "Existing");

    fs.ensureDirSync(original);
    fs.writeFileSync(path.join(original, "keep.txt"), "keep");

    writeAll([{ title: "Existing" }], function () {
      expect(fs.readFileSync(path.join(original, "keep.txt"), "utf8")).toBe(
        "keep"
      );
      expect(
        fs.existsSync(path.join(output, "Undated", "Existing-2.txt"))
      ).toBe(true);
      expect(fs.existsSync(path.join(output, "Undated", "Existing.txt"))).toBe(
        false
      );
      done();
    });
  });

  it("deduplicates file-backed and asset-backed posts with the same logical base in a batch", function (done) {
    var firstAssets = createAssets("import-assets-same-base-first-");
    var secondAssets = createAssets("import-assets-same-base-second-");

    writeAll(
      [
        { title: "Same Base" },
        { title: "Same Base", asset_directory: firstAssets },
        { title: "Reverse", asset_directory: secondAssets },
        { title: "Reverse" },
      ],
      function () {
        expect(
          fs.existsSync(path.join(output, "Undated", "Same-Base.txt"))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(output, "Undated", "Same-Base-2", "post.txt"))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(output, "Undated", "Reverse", "post.txt"))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(output, "Undated", "Reverse-2.txt"))
        ).toBe(true);
        done();
      }
    );
  });
});
