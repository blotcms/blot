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

  async function writeAll(entries) {
    var determine = determinePath(output);
    var write = createWriter();

    for (const entry of entries) {
      entry.content = entry.content || "body";
      await determine(entry);
      await write(entry);
    }
  }

  it("does not reserve paths across standalone default writer calls", async function () {
    var requestedPath = path.join(output, "name");

    await write({ path: requestedPath, content: "first" });

    fs.removeSync(path.join(output, "name.txt"));

    await write({ path: requestedPath, content: "second" });

    expect(fs.readFileSync(path.join(output, "name.txt"), "utf8")).toBe(
      "second"
    );
    expect(fs.existsSync(path.join(output, "name-2.txt"))).toBe(false);
  });

  it("deduplicates titles which collide after punctuation normalization", async function () {
    await writeAll([{ title: "Hello!" }, { title: "Hello?" }]);

    expect(fs.existsSync(path.join(output, "Undated", "Hello.txt"))).toBe(true);
    expect(fs.existsSync(path.join(output, "Undated", "Hello-2.txt"))).toBe(
      true
    );
  });

  it("deduplicates names which collide after 150-character truncation", async function () {
    var prefix = "a".repeat(150);
    await writeAll([{ title: prefix + "x" }, { title: prefix + "y" }]);

    expect(fs.existsSync(path.join(output, "Undated", prefix + ".txt"))).toBe(
      true
    );
    expect(
      fs.existsSync(
        path.join(output, "Undated", prefix.slice(0, 148) + "-2.txt")
      )
    ).toBe(true);
  });

  it("keeps suffixes visible within the filename limit", async function () {
    var entries = [];
    for (var i = 0; i < 10; i++) entries.push({ title: "x".repeat(160) });
    await writeAll(entries);

    expect(
      fs.existsSync(path.join(output, "Undated", "x".repeat(147) + "-10.txt"))
    ).toBe(true);
  });

  it("allows identical names in different destination directories", async function () {
    await writeAll([
      { title: "Same", page: true },
      { title: "Same", draft: true },
    ]);

    expect(fs.existsSync(path.join(output, "Pages", "Same.txt"))).toBe(true);
    expect(fs.existsSync(path.join(output, "Drafts", "Same.txt"))).toBe(true);
  });

  it("moves staged assets beside the final post.txt", async function () {
    var assets = fs.mkdtempSync(path.join(os.tmpdir(), "import-assets-"));
    fs.writeFileSync(path.join(assets, "_image.png"), "image");
    await writeAll([{ title: "With asset", asset_directory: assets }]);

    var destination = path.join(output, "Undated", "With-asset");
    expect(fs.readFileSync(path.join(destination, "_image.png"), "utf8")).toBe(
      "image"
    );
    expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
    expect(fs.existsSync(assets)).toBe(false);
  });

  it("allocates asset-backed posts away from an existing logical directory", async function () {
    var original = path.join(output, "Undated", "Existing");
    var assets = createAssets("import-assets-existing-dir-");

    fs.ensureDirSync(original);
    fs.writeFileSync(path.join(original, "keep.txt"), "keep");

    await writeAll([{ title: "Existing", asset_directory: assets }]);

    var destination = path.join(output, "Undated", "Existing-2");

    expect(fs.readFileSync(path.join(original, "keep.txt"), "utf8")).toBe(
      "keep"
    );
    expect(fs.existsSync(path.join(original, "post.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "_image.png"), "utf8")).toBe(
      "image"
    );
    expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
  });

  it("allocates asset-backed posts away from an existing logical text file", async function () {
    var assets = createAssets("import-assets-existing-file-");

    fs.ensureDirSync(path.join(output, "Undated"));
    fs.writeFileSync(path.join(output, "Undated", "Existing.txt"), "existing");

    await writeAll([{ title: "Existing", asset_directory: assets }]);

    var destination = path.join(output, "Undated", "Existing-2");

    expect(
      fs.readFileSync(path.join(output, "Undated", "Existing.txt"), "utf8")
    ).toBe("existing");
    expect(fs.readFileSync(path.join(destination, "_image.png"), "utf8")).toBe(
      "image"
    );
    expect(fs.existsSync(path.join(destination, "post.txt"))).toBe(true);
  });

  it("allocates file-backed posts away from an existing logical directory", async function () {
    var original = path.join(output, "Undated", "Existing");

    fs.ensureDirSync(original);
    fs.writeFileSync(path.join(original, "keep.txt"), "keep");

    await writeAll([{ title: "Existing" }]);

    expect(fs.readFileSync(path.join(original, "keep.txt"), "utf8")).toBe(
      "keep"
    );
    expect(fs.existsSync(path.join(output, "Undated", "Existing-2.txt"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(output, "Undated", "Existing.txt"))).toBe(
      false
    );
  });

  it("deduplicates file-backed and asset-backed posts with the same logical base in a batch", async function () {
    var firstAssets = createAssets("import-assets-same-base-first-");
    var secondAssets = createAssets("import-assets-same-base-second-");

    await writeAll([
      { title: "Same Base" },
      { title: "Same Base", asset_directory: firstAssets },
      { title: "Reverse", asset_directory: secondAssets },
      { title: "Reverse" },
    ]);

    expect(fs.existsSync(path.join(output, "Undated", "Same-Base.txt"))).toBe(
      true
    );
    expect(
      fs.existsSync(path.join(output, "Undated", "Same-Base-2", "post.txt"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(output, "Undated", "Reverse", "post.txt"))
    ).toBe(true);
    expect(fs.existsSync(path.join(output, "Undated", "Reverse-2.txt"))).toBe(
      true
    );
  });
});
