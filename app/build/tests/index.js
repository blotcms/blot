describe("build", function () {
  var build = require("../index");
  var fs = require("fs-extra");
  var express = require("express");
  var app = express();
  var exif = require("../converters/img/exif");

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

  beforeEach(function () {
    this.build = async (path, contents) => {
      return new Promise((resolve, reject) => {
        fs.outputFileSync(this.blogDirectory + path, contents);
        require("../index")(this.blog, path, function (err, entry) {
          if (err) return reject(err);
          resolve(entry);
        });
      });
    };
  });

  it("handles image URLs with query strings", function (done) {
    // The test server defined above will only respond with an image if
    // the query string is preserved. I was running into an ampersand
    // encoding issue where the & was replaced with &amp;
    var contents = "<img src='" + this.origin + "/small.jpg?user=x&pass=y'/>";
    var path = "/hello.txt";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // verify the image was cached
      expect(entry.html).toContain("/_image_cache/");

      // verify a thumbnail was generated from the image
      expect(entry.thumbnail.small).toEqual(
        jasmine.objectContaining({
          name: "small.jpg",
        })
      );
      done();
    });
  });

  it("extracts tags from a file path", function (done) {
    const path = "/[foo]/[bar]/[baz].txt";
    const contents = "Hello";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, (err, entry) => {
      if (err) return done.fail(err);
      expect(entry.tags).toEqual(["foo", "bar", "baz"]);
      done();
    });
  });

  it("creates a page in a lowercase pages folder", function (done) {
    const path = "/pages/bar.txt";
    const contents = "# Hello";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, (err, entry) => {
      if (err) return done.fail(err);
      expect(entry.title).toEqual("Hello");
      expect(entry.page).toEqual(true);
      done();
    });
  });

  it("creates a page in an uppercase pages folder", function (done) {
    const path = "/Pages/far.txt";
    const contents = "# Hello";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, (err, entry) => {
      if (err) return done.fail(err);
      expect(entry.title).toEqual("Hello");
      expect(entry.page).toEqual(true);
      done();
    });
  });

  it("includes inline code tags in the summary", function (done) {
    var path = "/hello.txt";
    var contents = "# Title\n\nThis `should` appear ```in``` the summary";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);
      expect(entry.summary).toEqual("This should appear in the summary");
      done();
    });
  });

  it("excludes block code tags in the summary", function (done) {
    var path = "/hello.txt";
    var contents = "# Title\n\n```\nNot in\n```\n\nthe summary";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);
      expect(entry.summary).toEqual("the summary");
      done();
    });
  });

  it("resolves relative paths inside files", function (done) {
    var path = "/blog/foo.txt";
    var contents = "![Image](_foo.jpg)";
    var absolutePathToImage = "/blog/_foo.jpg";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // It won't be cached since the image doesn't exist
      expect(entry.html).toContain(absolutePathToImage);
      done();
    });
  });

  it("generates a blog post from an image with quotes in its filename", function (done) {
    var pathToImage = '/Hell"o\'W "orld.jpg';

    fs.copySync(__dirname + "/small.jpg", this.blogDirectory + pathToImage);

    build(this.blog, pathToImage, function (err, entry) {
      if (err) return done.fail(err);

      // verify the image was cached
      expect(entry.html).toContain("/_image_cache/");

      // verify a thumbnail was generated from the image
      expect(entry.thumbnail.small).toEqual(
        jasmine.objectContaining({
          name: "small.jpg",
        })
      );

      done();
    });
  });

  it("attaches sanitized EXIF data to image entries", function (done) {
    var path = "/gps.jpg";

    fs.copySync(
      require("path").join(__dirname, "../converters/img/tests/gps.jpg"),
      this.blogDirectory + path
    );

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

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

      done();
    });
  });

  it("handles images with accents and spaces in their filename", function (done) {
    var path = "/blog/Hello world.txt";
    var contents = "![Best Image Ever](óå g.jpg)";
    var pathToImage = "/blog/óå g.jpg";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.copySync(__dirname + "/small.jpg", this.blogDirectory + pathToImage);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // verify the image was cached
      expect(entry.html).toContain("/_image_cache/");

      // verify a thumbnail was generated from the image
      expect(entry.thumbnail.small).toEqual(
        jasmine.objectContaining({
          name: "small.jpg",
        })
      );

      done();
    });
  });

  it("will handle empty metadata", function (done) {
    var path = "/Hello.txt";
    var contents = "menu: \n\nHey";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.menu).toEqual(false);
      done();
    });
  });

  it("will not use as image to become a thumbnail if it is too small", function (done) {
    var path = "/Hello world.txt";
    var contents = "![Best Image Ever](test.jpg)";
    var pathToImage = "/test.jpg";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.copySync(__dirname + "/too-small.jpg", this.blogDirectory + pathToImage);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // verify no thumbnail was generated from the image
      expect(entry.thumbnail).toEqual({});
      done();
    });
  });

  it("will not include caption text in summaries", function (done) {
    var path = "/Hello world.txt";
    var contents = "# Hello\n\n![Image caption](file.jpg)\n\nWorld";

    fs.outputFileSync(this.blogDirectory + path, contents);

    let blog = this.blog;
    blog.plugins.imageCaption.enabled = true;

    build(blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // verify a thumbnail was generated from the image
      expect(entry.summary).toEqual("World");

      done();
    });
  });

  it("will not generate a publish dateStamp for files without a date in their metadata or path", function (done) {
    var path = "/No-date-in-this-path.txt";
    var contents = "No date in this file";

    fs.outputFileSync(this.blogDirectory + path, contents);
    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);
      expect(entry.dateStamp).toEqual(undefined);
      done();
    });
  });

  describe("dateStamp and the entry's creation time", function () {
    var Entry = require("models/entry");
    var moment = require("moment");

    it("uses the current time for a brand new entry whose date-only metadata matches today", function (done) {
      var path = "/date-only-brand-new.txt";
      var blog = this.blog;
      var dateOnly = moment.utc().format("M/D/YYYY");

      fs.outputFileSync(
        this.blogDirectory + path,
        "Date: " + dateOnly + "\n\nBrand new post"
      );

      var before = Date.now();

      build(blog, path, function (err, entry) {
        if (err) return done.fail(err);
        var after = Date.now();

        // A brand new entry has no stored 'created' yet - Entry.set is
        // about to assign it Date.now() moments after this build
        // finishes, so build() should use that same instant rather than
        // defaulting to midnight (which would otherwise only get fixed by
        // a later, unrelated rebuild).
        expect(entry.dateStamp).toBeGreaterThanOrEqual(before);
        expect(entry.dateStamp).toBeLessThanOrEqual(after);

        done();
      });
    });

    it("uses the entry's original creation time when a rebuild's date-only metadata falls on the same day", function (done) {
      var path = "/date-only-same-day.txt";
      var blog = this.blog;

      fs.outputFileSync(this.blogDirectory + path, "No date in this file yet");

      build(blog, path, function (err, entry) {
        if (err) return done.fail(err);

        // Simulate this entry having first been created earlier today,
        // at a specific time, by directly setting its 'created' field.
        var createdAt = moment.utc().startOf("day").add(15, "hours").add(30, "minutes").valueOf();

        Entry.set(blog.id, path, Object.assign({}, entry, { created: createdAt }), function (err) {
          if (err) return done.fail(err);

          var dateOnly = moment.utc().format("M/D/YYYY");
          fs.outputFileSync(
            this.blogDirectory + path,
            "Date: " + dateOnly + "\n\nNow with a date"
          );

          build(blog, path, function (err, rebuiltEntry) {
            if (err) return done.fail(err);

            expect(moment.utc(rebuiltEntry.dateStamp).format("YYYY-MM-DD HH:mm")).toEqual(
              moment.utc(createdAt).format("YYYY-MM-DD HH:mm")
            );

            done();
          });
        }.bind(this));
      }.bind(this));
    });

    it("does not use the entry's creation time when the metadata date is a different day", function (done) {
      var path = "/date-only-different-day.txt";
      var blog = this.blog;

      fs.outputFileSync(this.blogDirectory + path, "No date in this file yet");

      build(blog, path, function (err, entry) {
        if (err) return done.fail(err);

        var createdAt = moment.utc().subtract(10, "days").add(15, "hours").valueOf();

        Entry.set(blog.id, path, Object.assign({}, entry, { created: createdAt }), function (err) {
          if (err) return done.fail(err);

          var dateOnly = moment.utc().format("M/D/YYYY");
          fs.outputFileSync(
            this.blogDirectory + path,
            "Date: " + dateOnly + "\n\nNow with a date"
          );

          build(blog, path, function (err, rebuiltEntry) {
            if (err) return done.fail(err);

            // Falls back to midnight since the metadata date doesn't
            // match the day the entry was originally created.
            expect(moment.utc(rebuiltEntry.dateStamp).format("HH:mm")).toEqual(
              "00:00"
            );

            done();
          });
        }.bind(this));
      }.bind(this));
    });
  });

  it("will not cache image an image using the static query string", function (done) {
    var path = "/Hello world.txt";
    var contents = "<img src='" + this.origin + "/public.jpg?static=1'>";

    // we use an img tag instead of a markdown image because for
    // some reason the version of Pandoc running on Blot's CI server
    // creates <embed>'s instead of <img> for certain URLs
    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // verify the image was not cached
      expect(entry.html).not.toContain("/_image_cache/");

      // verify a thumbnail was still generated from the image
      expect(entry.thumbnail.small).toEqual(
        jasmine.objectContaining({
          name: "small.jpg",
        })
      );

      done();
    });
  });

  it("will generate a list of internal links", async function (done) {
    const path = "/post.txt";
    const contents = "[linker](/linked)";
    const entry = await this.build(path, contents);

    expect(entry.internalLinks).toEqual(["/linked"]);
    done();
  });

  it("will generate an empty list of internal links", async function (done) {
    const path = "/post.txt";
    const contents = "Hey no link here.";
    const entry = await this.build(path, contents);

    expect(entry.internalLinks).toEqual([]);
    done();
  });

  it("will preserve nested YAML metadata arrays and objects", async function (done) {
    const path = "/post.txt";
    const contents = `---\narray:\n  - one\n  - two\nobject:\n  key: value\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({
      array: ["one", "two"],
      object: { key: "value" },
    });

    done();
  });

  it("will tolerate empty YAML front matter", async function (done) {
    const path = "/post.txt";
    const contents = `---\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({});
    expect(entry.html.trim()).toEqual('<h1 id="hello">Hello</h1>');

    done();
  });

  it("will extract tags in nested YAML metadata arrays", async function (done) {
    const path = "/post.txt";
    const contents = `---\ntags:\n  - one\n  - two\nobject:\n  key: value\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.metadata).toEqual({
      tags: ["one", "two"],
      object: { key: "value" },
    });

    expect(entry.tags).toEqual(["one", "two"]);

    done();
  });

  it("will build without error if date is a YAML array (i.e. not a string)", async function (done) {
    const path = "/post.txt";
    const contents = `---\ndate:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
    done();
  });

  it("will build without error if page is a YAML array (i.e. not a string)", async function (done) {
    const path = "/post.txt";
    const contents = `---\npage:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
    done();
  });

  it("will build without error if draft is a YAML array (i.e. not a bool)", async function (done) {
    const path = "/post.txt";
    const contents = `---\ndraft:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
    done();
  });

  it("will build without error if menu is a YAML array (i.e. not a bool)", async function (done) {
    const path = "/post.txt";
    const contents = `---\nmenu:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
    done();
  });

  it("will build without error if thumbnail is a YAML array (i.e. not a string)", async function (done) {
    const path = "/post.txt";
    const contents = `---\nthumbnail:\n  - 2020\n  - 12\n  - 25\n---\n\n# Hello`;
    const entry = await this.build(path, contents);

    expect(entry.path).toEqual(path);
    done();
  });
});
