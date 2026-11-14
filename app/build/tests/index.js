describe("build", function () {
  var build = require("../index");
  var fs = require("fs-extra");
  var folder = require("storage/folder");
  var os = require("os");
  var express = require("express");
  var app = express();

  // Only serve a test image when query contains valid user and password
  app.get("/small.jpg", function (req, res) {
    if (req.query && req.query.user === "x" && req.query.pass === "y")
      res.sendFile(__dirname + "/small.jpg");
    else res.sendStatus(400);
  });

  app.get("/public.jpg", function (req, res) {
    res.sendFile(__dirname + "/small.jpg");
  });

  global.test.blog();

  global.test.server(app);

  var buildEntry = (blog, path) => build(blog, path);

  // Writes a file into the blog's folder with the given modified time (ms)
  var put = async (blogID, path, contents, modified) => {
    var local =
      os.tmpdir() + "/build-tests-" + blogID + "-" + Date.now() + Math.random();
    await fs.outputFile(local, contents);
    try {
      await folder.writeFrom(blogID, path, local, { modified: modified });
    } finally {
      await fs.remove(local);
    }
  };

  beforeEach(function () {
    this.build = async (path, contents) => {
      await folder.write(this.blog.id, path, contents);
      return buildEntry(this.blog, path);
    };
  });

  it("handles image URLs with query strings", async function () {
    // The test server defined above will only respond with an image if
    // the query string is preserved. I was running into an ampersand
    // encoding issue where the & was replaced with &amp;
    var contents = "<img src='" + this.origin + "/small.jpg?user=x&pass=y'/>";
    var path = "/hello.txt";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    // verify the image was cached
    expect(entry.html).toContain("/_image_cache/");

    // verify a thumbnail was generated from the image
    expect(entry.thumbnail.small).toEqual(
      jasmine.objectContaining({
        name: "small.jpg",
      })
    );
  });

  it("extracts tags from a file path", async function () {
    const path = "/[foo]/[bar]/[baz].txt";
    const contents = "Hello";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.tags).toEqual(["foo", "bar", "baz"]);
  });

  it("creates a page in a lowercase pages folder", async function () {
    const path = "/pages/bar.txt";
    const contents = "# Hello";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.title).toEqual("Hello");
    expect(entry.page).toEqual(true);
  });

  it("creates a page in an uppercase pages folder", async function () {
    const path = "/Pages/far.txt";
    const contents = "# Hello";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.title).toEqual("Hello");
    expect(entry.page).toEqual(true);
  });

  it("includes inline code tags in the summary", async function () {
    var path = "/hello.txt";
    var contents = "# Title\n\nThis `should` appear ```in``` the summary";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.summary).toEqual("This should appear in the summary");
  });

  it("excludes block code tags in the summary", async function () {
    var path = "/hello.txt";
    var contents = "# Title\n\n```\nNot in\n```\n\nthe summary";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.summary).toEqual("the summary");
  });

  it("resolves relative paths inside files", async function () {
    var path = "/blog/foo.txt";
    var contents = "![Image](_foo.jpg)";
    var absolutePathToImage = "/blog/_foo.jpg";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    // It won't be cached since the image doesn't exist
    expect(entry.html).toContain(absolutePathToImage);
  });

  it("generates a blog post from an image with quotes in its filename", async function () {
    var pathToImage = '/Hell"o\'W "orld.jpg';

    await folder.writeFrom(this.blog.id, pathToImage, __dirname + "/small.jpg");

    var entry = await buildEntry(this.blog, pathToImage);

    // verify the image was cached
    expect(entry.html).toContain("/_image_cache/");

    // verify a thumbnail was generated from the image
    expect(entry.thumbnail.small).toEqual(
      jasmine.objectContaining({
        name: "small.jpg",
      })
    );
  });

  it("attaches sanitized EXIF data to image entries", async function () {
    var path = "/gps.jpg";

    await folder.writeFrom(
      this.blog.id,
      path,
      require("path").join(__dirname, "../converters/img/tests/gps.jpg")
    );

    var entry = await buildEntry(this.blog, path);

    expect(entry.exif).toEqual({
      ImageDescription: "                               ",
      Make: "NIKON",
      Model: "COOLPIX P6000",
      ExposureTime: "1/178",
      FNumber: 4.5,
      ISO: 64,
      Flash: "Off, Did not fire",
      FocalLength: 6,
    });
  });

  it("uses an image's photo caption as its caption and summary", async function () {
    var path = "/photos.jpg";

    await folder.writeFrom(
      this.blog.id,
      path,
      require("path").join(
        __dirname,
        "../converters/img/tests/captions/photos.jpg"
      )
    );

    this.blog.imageExif = "basic";
    this.blog.plugins.imageCaption.enabled = true;

    var entry = await buildEntry(this.blog, path);
    var caption =
      'Sunset at <strong>Point Reyes</strong>, by <a href="https://ann.example">Ann</a>';

    expect(entry.caption).toEqual(caption);
    expect(entry.summary).toEqual("Sunset at Point Reyes, by Ann");
    expect(entry.title).toEqual("photos");
    expect(entry.html).toContain(
      '<span class="caption">' + caption + "</span>"
    );
    expect(entry.html).not.toContain('<span class="caption">photos</span>');
    expect(entry.html).toContain('alt="photos"');
    expect(entry.exif.ImageDescription).toEqual(caption);
  });

  it("leaves the caption out when EXIF is off", async function () {
    var path = "/photos.jpg";

    await folder.writeFrom(
      this.blog.id,
      path,
      require("path").join(
        __dirname,
        "../converters/img/tests/captions/photos.jpg"
      )
    );

    this.blog.imageExif = "off";
    this.blog.plugins.imageCaption.enabled = true;

    var entry = await buildEntry(this.blog, path);

    expect(entry.caption).toEqual("");
    expect(entry.summary).toEqual("");
    expect(entry.html).toContain('<span class="caption">photos</span>');
  });

  it("captions an image without a photo caption with its title", async function () {
    var path = "/gps.jpg";

    await folder.writeFrom(
      this.blog.id,
      path,
      require("path").join(__dirname, "../converters/img/tests/gps.jpg")
    );

    this.blog.plugins.imageCaption.enabled = true;

    var entry = await buildEntry(this.blog, path);

    expect(entry.caption).toEqual("");
    expect(entry.summary).toEqual("");
    expect(entry.html).toContain('<span class="caption">gps</span>');
  });

  it("handles images with accents and spaces in their filename", async function () {
    var path = "/blog/Hello world.txt";
    var contents = "![Best Image Ever](óå g.jpg)";
    var pathToImage = "/blog/óå g.jpg";

    await folder.write(this.blog.id, path, contents);
    await folder.writeFrom(this.blog.id, pathToImage, __dirname + "/small.jpg");

    var entry = await buildEntry(this.blog, path);

    // verify the image was cached
    expect(entry.html).toContain("/_image_cache/");

    // verify a thumbnail was generated from the image
    expect(entry.thumbnail.small).toEqual(
      jasmine.objectContaining({
        name: "small.jpg",
      })
    );
  });

  it("will handle empty metadata", async function () {
    var path = "/Hello.txt";
    var contents = "menu: \n\nHey";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.menu).toEqual(false);
  });

  it("will not use as image to become a thumbnail if it is too small", async function () {
    var path = "/Hello world.txt";
    var contents = "![Best Image Ever](test.jpg)";
    var pathToImage = "/test.jpg";

    await folder.write(this.blog.id, path, contents);
    await folder.writeFrom(
      this.blog.id,
      pathToImage,
      __dirname + "/too-small.jpg"
    );

    var entry = await buildEntry(this.blog, path);

    // verify no thumbnail was generated from the image
    expect(entry.thumbnail).toEqual({});
  });

  it("will not include caption text in summaries", async function () {
    var path = "/Hello world.txt";
    var contents = "# Hello\n\n![Image caption](file.jpg)\n\nWorld";

    await folder.write(this.blog.id, path, contents);

    let blog = this.blog;
    blog.plugins.imageCaption.enabled = true;

    var entry = await buildEntry(blog, path);

    // verify a thumbnail was generated from the image
    expect(entry.summary).toEqual("World");
  });

  it("will not generate a publish dateStamp for files without a date in their metadata or path", async function () {
    var path = "/No-date-in-this-path.txt";
    var contents = "No date in this file";

    await folder.write(this.blog.id, path, contents);
    var entry = await buildEntry(this.blog, path);

    expect(entry.dateStamp).toEqual(undefined);
  });

  describe("dateStamp and the entry's creation time", function () {
    var Entry = require("models/entry");
    var moment = require("moment");

    var setEntry = async (blogID, path, entry) => {
      await Entry.set(blogID, path, entry);
    };

    it("uses the current time for a brand new entry whose date-only metadata matches today", async function () {
      var path = "/date-only-brand-new.txt";
      var blog = this.blog;
      var dateOnly = moment.utc().format("M/D/YYYY");

      await folder.write(
        blog.id,
        path,
        "Date: " + dateOnly + "\n\nBrand new post"
      );

      var before = Date.now();

      var entry = await buildEntry(blog, path);
      var after = Date.now();

      // A brand new entry has no stored 'created' yet - Entry.set is
      // about to assign it Date.now() moments after this build
      // finishes, so build() should use that same instant rather than
      // defaulting to midnight (which would otherwise only get fixed by
      // a later, unrelated rebuild).
      expect(entry.dateStamp).toBeGreaterThanOrEqual(before);
      expect(entry.dateStamp).toBeLessThanOrEqual(after);
    });

    it("uses the entry's original creation time when a rebuild's date-only metadata falls on the same day", async function () {
      var path = "/date-only-same-day.txt";
      var blog = this.blog;

      await folder.write(blog.id, path, "No date in this file yet");

      var entry = await buildEntry(blog, path);

      // Simulate this entry having first been created earlier today,
      // at a specific time, by directly setting its 'created' field.
      var createdAt = moment
        .utc()
        .startOf("day")
        .add(15, "hours")
        .add(30, "minutes")
        .valueOf();

      await setEntry(
        blog.id,
        path,
        Object.assign({}, entry, { created: createdAt })
      );

      var dateOnly = moment.utc().format("M/D/YYYY");
      await folder.write(
        blog.id,
        path,
        "Date: " + dateOnly + "\n\nNow with a date"
      );

      var rebuiltEntry = await buildEntry(blog, path);

      expect(
        moment.utc(rebuiltEntry.dateStamp).format("YYYY-MM-DD HH:mm")
      ).toEqual(moment.utc(createdAt).format("YYYY-MM-DD HH:mm"));
    });

    it("does not use the entry's creation time when the metadata date is a different day", async function () {
      var path = "/date-only-different-day.txt";
      var blog = this.blog;

      await folder.write(blog.id, path, "No date in this file yet");

      var entry = await buildEntry(blog, path);

      var createdAt = moment
        .utc()
        .subtract(10, "days")
        .add(15, "hours")
        .valueOf();

      await setEntry(
        blog.id,
        path,
        Object.assign({}, entry, { created: createdAt })
      );

      var dateOnly = moment.utc().format("M/D/YYYY");
      await folder.write(
        blog.id,
        path,
        "Date: " + dateOnly + "\n\nNow with a date"
      );

      var rebuiltEntry = await buildEntry(blog, path);

      // Falls back to midnight since the metadata date doesn't
      // match the day the entry was originally created.
      expect(moment.utc(rebuiltEntry.dateStamp).format("HH:mm")).toEqual(
        "00:00"
      );
    });
  });

  it("will not cache image an image using the static query string", async function () {
    var path = "/Hello world.txt";
    var contents = "<img src='" + this.origin + "/public.jpg?static=1'>";

    // we use an img tag instead of a markdown image because for
    // some reason the version of Pandoc running on Blot's CI server
    // creates <embed>'s instead of <img> for certain URLs
    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    // verify the image was not cached
    expect(entry.html).not.toContain("/_image_cache/");

    // verify a thumbnail was still generated from the image
    expect(entry.thumbnail.small).toEqual(
      jasmine.objectContaining({
        name: "small.jpg",
      })
    );
  });

  it("will generate a list of internal links", async function () {
    const path = "/post.txt";
    const contents = "[linker](/linked)";
    const entry = await this.build(path, contents);

    expect(entry.internalLinks).toEqual(["/linked"]);
  });

  it("will generate an empty list of internal links", async function () {
    const path = "/post.txt";
    const contents = "Hey no link here.";
    const entry = await this.build(path, contents);

    expect(entry.internalLinks).toEqual([]);
  });

  it("will preserve nested YAML metadata arrays and objects", async function () {
    const path = "/post.txt";
    const contents = `---\narray:\n  - one\n  - two\nobject:\n  key: value\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({
      array: ["one", "two"],
      object: { key: "value" },
    });
  });

  it("will tolerate empty YAML front matter", async function () {
    const path = "/post.txt";
    const contents = `---\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({});
    expect(entry.html.trim()).toEqual('<h1 id="hello">Hello</h1>');
  });

  it("will extract tags in nested YAML metadata arrays", async function () {
    const path = "/post.txt";
    const contents = `---\ntags:\n  - one\n  - two\nobject:\n  key: value\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({
      tags: ["one", "two"],
      object: { key: "value" },
    });

    expect(entry.tags).toEqual(["one", "two"]);
  });

  it("will build without error if date is a YAML array (i.e. not a string)", async function () {
    const path = "/post.txt";
    const contents = `---\ndate:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
  });

  it("will build without error if page is a YAML array (i.e. not a string)", async function () {
    const path = "/post.txt";
    const contents = `---\npage:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
  });

  it("will build without error if draft is a YAML array (i.e. not a bool)", async function () {
    const path = "/post.txt";
    const contents = `---\ndraft:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
  });

  it("will build without error if menu is a YAML array (i.e. not a bool)", async function () {
    const path = "/post.txt";
    const contents = `---\nmenu:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
  });

  it("will build without error if thumbnail is a YAML array (i.e. not a string)", async function () {
    const path = "/post.txt";
    const contents = `---\nthumbnail:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
  });

  describe("'updated' and contentHash", function () {
    var Entry = require("models/entry");
    var moment = require("moment");

    var setEntry = async (blogID, path, entry) => {
      await Entry.set(blogID, path, entry);
    };

    // Builds a file already in the blog's folder, leaving its mtime alone
    var buildExisting = buildEntry;

    it("takes 'updated' from the file's mtime to the millisecond", async function () {
      var path = "/updated-precise.txt";

      await put(this.blog.id, path, "Some content", 1700000000123);

      var entry = await buildExisting(this.blog, path);

      expect(entry.updated).toEqual(1700000000123);
      expect(entry.updated).toEqual(
        moment.utc((await folder.stat(this.blog.id, path)).modified).valueOf()
      );
    });

    it("hashes the SHA-1 of the source's bytes, reading it once", async function () {
      var crypto = require("crypto");
      var path = "/hash-once.txt";
      var contents = "Hash me";

      await folder.write(this.blog.id, path, contents);

      var blogID = this.blog.id;
      var read = spyOn(folder, "createReadStream").and.callThrough();
      var entry = await buildExisting(this.blog, path);
      var sourceHash = crypto.createHash("sha1").update(contents).digest("hex");

      expect(entry.contentHash).toEqual(
        crypto
          .createHash("sha1")
          .update(path + ":" + sourceHash)
          .digest("hex")
      );
      expect(
        read.calls
          .allArgs()
          .filter((args) => args[0] === blogID && args[1] === path).length
      ).toEqual(1);
    });

    it("keeps 'updated' unchanged when only the file's mtime changes", async function () {
      var path = "/updated-mtime-only.txt";
      var blog = this.blog;

      await folder.write(blog.id, path, "Same content");

      var entry = await buildEntry(blog, path);

      await setEntry(blog.id, path, entry);

      // Bump the file's mtime without touching its bytes - this
      // mirrors a Dropbox/Drive/iCloud reconnect or full resync
      // re-downloading an unchanged file.
      var newMtime = new Date(Date.now() + 60 * 60 * 1000);
      await put(blog.id, path, "Same content", newMtime.getTime());

      var rebuiltEntry = await buildEntry(blog, path);

      expect(rebuiltEntry.contentHash).toEqual(entry.contentHash);
      expect(rebuiltEntry.updated).toEqual(entry.updated);
    });

    it("changes 'updated' to the new mtime when the file's content changes", async function () {
      var path = "/updated-content-changed.txt";
      var blog = this.blog;

      await folder.write(blog.id, path, "Original content");

      var entry = await buildEntry(blog, path);

      await setEntry(blog.id, path, entry);

      var newMtime = new Date(Date.now() + 60 * 60 * 1000);
      await put(blog.id, path, "Changed content", newMtime.getTime());

      var rebuiltEntry = await buildEntry(blog, path);

      expect(rebuiltEntry.contentHash).not.toEqual(entry.contentHash);
      expect(rebuiltEntry.updated).toEqual(moment.utc(newMtime).valueOf());
      expect(rebuiltEntry.updated).not.toEqual(entry.updated);
    });
  });
});
