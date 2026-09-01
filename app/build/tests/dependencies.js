describe("dependencies", function () {
  var build = require("../index");
  var fs = require("fs-extra");
  var nock = require("nock");
  var sharp = require("sharp");

  global.test.blog();

  it("are extracted inside entry contents", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](_foo.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.dependencies).toEqual(["/_foo.jpg"]);
      done();
    });
  });

  it("are extracted from entry metadata", function (done) {
    var path = "/Hello.txt";
    var contents = "Thumbnail: _bar.jpg";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.dependencies).toEqual(["/_bar.jpg"]);
      done();
    });
  });

  afterEach(function () {
    nock.cleanAll();
  });

  it("resolves a relative link to a local file", function (done) {
    var path = "/Docs/report.txt";
    var contents = "[Download](report.pdf)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/Docs/report.pdf", "fake pdf");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.dependencies).toEqual(["/Docs/report.pdf"]);
      expect(entry.html).toContain('href="/Docs/report.pdf"');
      done();
    });
  });

  it("resolves an image wrapped in a link to the same image", function (done) {
    var path = "/Photos/vacation.txt";
    var contents = "[![Beach](beach.jpg)](beach.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/Photos/beach.jpg", "fake image");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // The link keeps pointing at the original file in the folder...
      expect(entry.html).toContain('href="/Photos/beach.jpg"');
      // ...while the image plugin is free to rewrite the <img> src
      // separately (e.g. to a cached/optimized CDN URL).
      expect(entry.html).toMatch(/<a href="\/Photos\/beach\.jpg"><img/);
      done();
    });
  });

  it("does not resolve fragment-only links, e.g. footnotes", function (done) {
    var path = "/Post.txt";
    var contents = "Some text.[^1]\n\n[^1]: A footnote.";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // Footnote refs/backlinks are fragment-only hrefs (e.g.
      // href="#footnote-xyz") - they must stay untouched rather
      // than being resolved into a local file path.
      expect(entry.html).toMatch(/href="#[^"]+"/);
      expect(entry.html).not.toMatch(/href="\/Post\.txt#/);
      expect(entry.dependencies).toEqual([]);
      done();
    });
  });

  it("ignores URLs", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](//example.com/_foo.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);

    sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer()
      .then((buffer) => {
        // The image caching plugin expects a real JPEG payload to proceed.
        nock("http://example.com").get("/_foo.jpg").reply(200, buffer);

        build(this.blog, path, function (err, entry) {
          if (err) return done.fail(err);

          expect(entry.dependencies).toEqual([]);
          done();
        });
      })
      .catch(done.fail);
  });
});
