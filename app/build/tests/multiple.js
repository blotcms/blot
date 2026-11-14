describe("build multiple", function () {
  var build = require("../index");
  var folder = require("storage/folder");
  var path = require("path");

  global.test.blog();

  beforeEach(function () {
    this.buildEntry = (targetPath) => build(this.blog, targetPath);
  });

  it("aggregates convertible files inside a + folder", async function () {
    var root = "/album+";

    await folder.write(
      this.blog.id,
      path.join(root, "one.md"),
      "# One\n\nBody"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "two.md"),
      "## Second\n\n![Image](/album+/cover.jpg)"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "cover.jpg"),
      Buffer.from("fake")
    );

    var entry = await this.buildEntry("/album+");

    expect(entry.path).toEqual("/album");
    expect(entry.html).toContain(
      '<section class="multi-file-post" data-folder="/album+">'
    );
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/album+/cover.jpg" data-index="0" data-extension="jpg">'
    );
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/album+/one.md" data-index="1" data-extension="md">'
    );
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/album+/two.md" data-index="2" data-extension="md">'
    );
    expect(entry.html).toContain('<h1 id="one">One</h1>');
    expect(entry.html).toContain("<p>Body</p>");
    expect(entry.html).toContain('<h2 id="second">Second</h2>');
    expect(entry.metadata._sourcePaths.sort()).toEqual([
      "/album+/cover.jpg",
      "/album+/one.md",
      "/album+/two.md",
    ]);
    expect(entry.dependencies).toEqual(["/album+/cover.jpg"]);
  });

  it("leaves the photo's caption out of a folder post", async function () {
    var root = "/photos+";

    await folder.write(this.blog.id, path.join(root, "notes.md"), "Notes");
    await folder.writeFrom(
      this.blog.id,
      path.join(root, "photos.jpg"),
      path.join(__dirname, "../converters/img/tests/captions/photos.jpg")
    );

    this.blog.imageExif = "basic";
    this.blog.plugins.imageCaption.enabled = true;

    var entry = await this.buildEntry("/photos+");

    expect(entry.caption).toEqual("");
    expect(entry.html).toContain('<span class="caption">photos</span>');
    expect(entry.html).not.toContain("Point Reyes</strong>");
  });

  it("builds the aggregated entry when a child file is targeted", async function () {
    var root = "/note+";

    await folder.write(this.blog.id, path.join(root, "first.md"), "# First");
    await folder.write(this.blog.id, path.join(root, "second.md"), "# Second");

    var entry = await this.buildEntry("/note+/first.md");

    expect(entry.path).toEqual("/note");
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/note+/first.md" data-index="0" data-extension="md">'
    );
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/note+/second.md" data-index="1" data-extension="md">'
    );
    expect(entry.html).toContain("First");
    expect(entry.html).toContain("Second");
  });

  it("injects a folder-based title when no heading exists", async function () {
    var root = "/vacation-photos+";

    await folder.write(
      this.blog.id,
      path.join(root, "notes.md"),
      "A quiet afternoon on the beach."
    );

    var entry = await this.buildEntry("/vacation-photos+");

    expect(entry.html).toContain(
      '<h1 class="multi-file-title">Vacation Photos</h1>'
    );
    expect(entry.html).toContain(
      '<section class="multi-file-entry" data-file="/vacation-photos+/notes.md" data-index="0" data-extension="md">'
    );
  });

  it("maps bracketed plus folders to a stripped entry path", function () {
    expect(build.findMultiFolder("/[Blog]+/one.md")).toEqual({
      folderPath: "/[Blog]+",
      entryPath: "/[Blog]",
      triggerPath: "/[Blog]+/one.md",
    });
  });

  it("omits files whose converter is disabled", async function () {
    this.blog.converters = Object.assign({}, this.blog.converters, {
      img: false,
    });

    var root = "/album+";
    await folder.write(this.blog.id, path.join(root, "one.md"), "# One");
    await folder.write(
      this.blog.id,
      path.join(root, "cover.jpg"),
      Buffer.from("fake")
    );

    var entry = await this.buildEntry("/album+");

    expect(entry.metadata._sourcePaths).toEqual(["/album+/one.md"]);
    expect(entry.html).not.toContain("cover.jpg");
  });

  it("unions comma-separated tags from every source file", async function () {
    var root = "/tagged+";

    await folder.write(
      this.blog.id,
      path.join(root, "one.md"),
      "Tags: alpha, beta\n\n# One"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "two.md"),
      "Tags: beta, gamma\n\n# Two"
    );

    var entry = await this.buildEntry("/tagged+");

    expect(entry.tags.slice().sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("unions tags even when source files spell the key with different case", async function () {
    var root = "/tagcase+";

    await folder.write(
      this.blog.id,
      path.join(root, "one.md"),
      "Tags: alpha\n\n# One"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "two.md"),
      "tags: beta\n\n# Two"
    );

    var entry = await this.buildEntry("/tagcase+");

    expect(entry.tags.slice().sort()).toEqual(["alpha", "beta"]);
  });

  it("lets a later source file replace a non-tag metadata array instead of unioning it", async function () {
    var root = "/authors+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      ["---", "Authors:", "  - Alice", "---", "", "# One"].join("\n")
    );
    await folder.write(
      this.blog.id,
      path.join(root, "02.md"),
      ["---", "Authors:", "  - Bob", "---", "", "# Two"].join("\n")
    );

    var entry = await this.buildEntry("/authors+");

    // Only Tags are documented as unioned; every other repeated array
    // follows the same "later file wins" rule as a scalar.
    expect(entry.metadata.Authors).toEqual(["Bob"]);
  });

  it("excludes .textbundle asset files from folder post sources", async function () {
    var root = "/bundle+";

    await folder.write(
      this.blog.id,
      path.join(root, "note.textbundle", "text.md"),
      "# Note\n\n![Pic](assets/pic.png)"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "note.textbundle", "assets", "pic.png"),
      Buffer.from("fake")
    );

    var entry = await this.buildEntry("/bundle+");

    expect(entry.metadata._sourcePaths).not.toContain(
      "/bundle+/note.textbundle/assets/pic.png"
    );
    expect(entry.html).not.toContain(
      'data-file="/bundle+/note.textbundle/assets/pic.png"'
    );
  });

  it("lets later source files override a repeated scalar metadata key", async function () {
    var root = "/drafty+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "Draft: no\n\n# One"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "02.md"),
      "Draft: yes\n\n# Two"
    );

    var entry = await this.buildEntry("/drafty+");

    expect(entry.draft).toBe(true);
  });

  it("lets a later source file clear an earlier scalar value", async function () {
    var root = "/undrafty+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "Draft: yes\n\n# One"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "02.md"),
      "Draft: no\n\n# Two"
    );

    var entry = await this.buildEntry("/undrafty+");

    expect(entry.draft).toBe(false);
  });

  it("overrides a repeated scalar key spelled with a different case", async function () {
    var root = "/titlecase+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "Title: First\n\n# One"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "02.md"),
      "title: Second\n\n# Two"
    );

    var entry = await this.buildEntry("/titlecase+");

    var titleKeys = Object.keys(entry.metadata).filter(function (key) {
      return key.toLowerCase() === "title";
    });
    expect(titleKeys.length).toBe(1);
    expect(entry.metadata[titleKeys[0]]).toBe("Second");
  });

  it("injects a heading when the only h1 is beyond the first three source files", async function () {
    var root = "/long-read+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "Intro paragraph."
    );
    await folder.write(this.blog.id, path.join(root, "02.md"), "More text.");
    await folder.write(this.blog.id, path.join(root, "03.md"), "Still going.");
    await folder.write(
      this.blog.id,
      path.join(root, "04.md"),
      "# The Real Heading\n\nBody."
    );

    var entry = await this.buildEntry("/long-read+");

    // prepare/title.js never reaches the 4th file's <h1>, so a heading is
    // injected and the stored title matches what renders at the top.
    expect(entry.html).toContain('<h1 class="multi-file-title">Long Read</h1>');
    expect(entry.title).toBe("Long Read");
  });

  it("does not inject a heading when an early source file has an h1", async function () {
    var root = "/early-head+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "No heading here."
    );
    await folder.write(
      this.blog.id,
      path.join(root, "02.md"),
      "# Second File Heading"
    );
    await folder.write(
      this.blog.id,
      path.join(root, "03.md"),
      "# Third File Heading"
    );

    var entry = await this.buildEntry("/early-head+");

    expect(entry.html).not.toContain('class="multi-file-title"');
  });

  it("injects a heading when the only h1 is past the first three nodes of a source file", async function () {
    var root = "/buried-head+";

    await folder.write(
      this.blog.id,
      path.join(root, "01.md"),
      "One.\n\nTwo.\n\nThree.\n\n# Buried Heading"
    );

    var entry = await this.buildEntry("/buried-head+");

    // prepare/title.js only inspects the first three children at each
    // nesting level, so a 4th-position heading within a single source file
    // is exactly as unreachable as one in a 4th source file.
    expect(entry.html).toContain(
      '<h1 class="multi-file-title">Buried Head</h1>'
    );
  });

  it("uses an explicit Title from metadata for the injected heading", async function () {
    var root = "/trip-photos+";

    await folder.write(
      this.blog.id,
      path.join(root, "notes.md"),
      "Title: A Weekend Away\n\nNo heading in the body."
    );

    var entry = await this.buildEntry("/trip-photos+");

    expect(entry.html).toContain(
      '<h1 class="multi-file-title">A Weekend Away</h1>'
    );
    expect(entry.html).not.toContain("Trip Photos</h1>");
  });

  it("resolves nested plus folders to the outermost + folder", function () {
    expect(build.findMultiFolder("/outer+/inner+/one.md")).toEqual({
      folderPath: "/outer+",
      entryPath: "/outer",
      triggerPath: "/outer+/inner+/one.md",
    });
  });

  it("does not collide trees that differ only by an ancestor +", function () {
    var a = build.findMultiFolder("/foo+/bar+/x.md");
    var b = build.findMultiFolder("/foo/bar+/x.md");

    expect(a.entryPath).toEqual("/foo");
    expect(b.entryPath).toEqual("/foo/bar");
    expect(a.entryPath).not.toEqual(b.entryPath);
  });

  it("returns an EMPTY error when no convertible files are present", async function () {
    var blog = this.blog;

    await folder.mkdir(blog.id, "/void+");

    var err;
    try {
      await build(blog, "/void+");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toEqual("EMPTY");
  });

  it("does not treat a plain file whose name ends in + as a folder post", async function () {
    await folder.write(
      this.blog.id,
      path.join("/", "post.md+"),
      "# Just A File"
    );

    var entry;
    var err;
    try {
      entry = await this.buildEntry("/post.md+");
    } catch (e) {
      err = e;
    }

    // Routed to the single-file builder, never the multi builder, so the
    // stripped path "/post.md" is left alone.
    if (err) {
      expect(err.code).not.toBe("ENOTDIR");
    } else {
      expect(entry.path).toBe("/post.md+");
      expect(entry.html).not.toContain('class="multi-file-post"');
    }
  });

  it("refuses to aggregate when the stripped path is a real sibling file", async function () {
    await folder.write(
      this.blog.id,
      path.join("/", "article.md"),
      "# The Real Article"
    );
    await folder.write(
      this.blog.id,
      path.join("/", "article.md+", "extra.md"),
      "# Extra section"
    );

    var err;
    try {
      await this.buildEntry("/article.md+/extra.md");
    } catch (e) {
      err = e;
    }

    expect(err && err.code).toBe("PLUS_PATH_COLLISION");
  });
});
