describe("folderAssets plugin", function () {
  var build = require("../../../index");
  var fs = require("fs-extra");
  var BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  global.test.blog();

  var tokenRegex = (path) =>
    new RegExp(
      `${BLOT_CDN_TOKEN.replace(/%/g, "\\%")}/folder/v-[a-f0-9]{8}/[^"]*${path}`
    );

  it("bakes a relative folder link into a %%BLOT_CDN%%-prefixed, versioned URL at build time", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/photo.jpg", "fake image data");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/photo\\.jpg"));
      done();
    });
  });

  it("leaves non-matching/ENOENT links untouched", function (done) {
    var path = "/Hello.txt";
    var contents = "[Missing](missing.pdf)";

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toContain('href="/missing.pdf"');
      expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
      done();
    });
  });

  it("leaves internal .html links untouched", function (done) {
    var path = "/Hello.txt";
    var contents = "[Other post](other.html)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/other.html", "<p>hi</p>");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toContain('href="/other.html"');
      expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
      done();
    });
  });

  it("produces a new version when the dependency file's content changes", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/photo.jpg", "version one");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

      fs.outputFileSync(this.blogDirectory + "/photo.jpg", "version two");

      build(this.blog, path, function (err, entry2) {
        if (err) return done.fail(err);

        var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

        expect(secondVersion).not.toEqual(firstVersion);
        done();
      });
    }.bind(this));
  });

  it("produces the same version for identical content even if the file was rewritten", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/photo.jpg", "same content");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

      fs.outputFileSync(this.blogDirectory + "/photo.jpg", "same content");

      build(this.blog, path, function (err, entry2) {
        if (err) return done.fail(err);

        var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

        expect(secondVersion).toEqual(firstVersion);
        done();
      });
    }.bind(this));
  });

  it("leaves reserved global-static prefixes unbaked even if the blog folder has a same-named file", function (done) {
    var path = "/Hello.txt";
    var contents = "![Font icon](fonts/icon.png) ![Katex](/katex/x.png)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/fonts/icon.png", "blog file");
    fs.outputFileSync(this.blogDirectory + "/katex/x.png", "blog file");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toContain('src="/fonts/icon.png"');
      expect(entry.html).toContain('src="/katex/x.png"');
      expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
      done();
    });
  });

  it("is not optional, so it runs for blogs without a stored folderAssets plugin entry", function () {
    var plugins = require("../../index");

    expect(plugins.list.folderAssets.optional).toBe(false);
  });

  it("bakes poster and srcset candidates and records them as dependencies", function (done) {
    var path = "/Hello.txt";
    var contents =
      '<video poster="/poster.jpg"></video>\n\n' +
      '<img src="/a.jpg" srcset="/a.jpg 1x, /a2.jpg 2x">';

    fs.outputFileSync(this.blogDirectory + path, contents);
    ["/poster.jpg", "/a.jpg", "/a2.jpg"].forEach((file) =>
      fs.outputFileSync(this.blogDirectory + file, "data " + file)
    );

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(
        new RegExp(`poster="${BLOT_CDN_TOKEN}/folder/v-[a-f0-9]{8}/[^"]*/poster\\.jpg"`)
      );
      expect(entry.html).toMatch(
        new RegExp(`srcset="[^"]*/a\\.jpg [^"]*1x, [^"]*/a2\\.jpg 2x"`)
      );
      expect(entry.dependencies).toContain("/poster.jpg");
      expect(entry.dependencies).toContain("/a2.jpg");
      expect(entry.dependencies.length).toEqual(
        new Set(entry.dependencies).size
      );
      done();
    });
  });

  it("only treats whole path segments as reserved (/fontsFoo is a normal folder)", function (done) {
    var path = "/Hello.txt";

    fs.outputFileSync(this.blogDirectory + path, "![Pic](/fontsFoo/pic.png)");
    fs.outputFileSync(this.blogDirectory + "/fontsFoo/pic.png", "blog file");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/fontsFoo/pic\\.png"));
      done();
    });
  });

  it("bakes absolute URLs on the blog's own host, and leaves other hosts alone", function (done) {
    var config = require("config");
    var path = "/Hello.txt";
    var own = `https://${this.blog.handle}.${config.host}`;
    var contents = `![Own](${own}/photo.jpg) ![Other](https://example.org/photo.jpg)`;

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/photo.jpg", "fake image data");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/photo\\.jpg"));
      expect(entry.html).not.toContain(own);
      expect(entry.html).toContain('src="https://example.org/photo.jpg"');
      expect(entry.dependencies).toContain("/photo.jpg");
      done();
    });
  });

  it("bakes a link to the entry's own file but doesn't record it as a dependency", function (done) {
    var path = "/Hello.txt";

    fs.outputFileSync(this.blogDirectory + path, "[Source](Hello.txt) [Other](other.pdf)");
    fs.outputFileSync(this.blogDirectory + "/other.pdf", "pdf");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/Hello\\.txt"));
      expect(entry.dependencies).not.toContain("/Hello.txt");
      expect(entry.dependencies).toContain("/other.pdf");
      done();
    });
  });

  it("resolves entry-relative poster and srcset paths before baking", function (done) {
    var path = "/posts/Hello.txt";
    var contents =
      '<video poster="movie.jpg"></video><img src="/posts/a.jpg" srcset="small.jpg 1x, ../big.jpg 2x">';

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/posts/movie.jpg", "m");
    fs.outputFileSync(this.blogDirectory + "/posts/small.jpg", "s");
    fs.outputFileSync(this.blogDirectory + "/big.jpg", "b");
    fs.outputFileSync(this.blogDirectory + "/posts/a.jpg", "a");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(new RegExp('poster="' + tokenRegex("/posts/movie\\.jpg").source));
      expect(entry.html).toMatch(tokenRegex("/posts/small\\.jpg 1x"));
      expect(entry.html).toMatch(tokenRegex("/big\\.jpg 2x"));
      expect(entry.dependencies).toContain("/posts/movie.jpg");
      expect(entry.dependencies).toContain("/posts/small.jpg");
      expect(entry.dependencies).toContain("/big.jpg");
      done();
    });
  });
});
