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

  it("produces the same version when only the file's mtime changes", function (done) {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";
    var photoPath = this.blogDirectory + "/photo.jpg";
    var blog = this.blog;

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(photoPath, "unchanged content");

    build(blog, path, function (err, entry) {
      if (err) return done.fail(err);

      var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

      fs.utimesSync(photoPath, new Date("2030-01-01"), new Date("2030-01-01"));

      build(blog, path, function (err, entry2) {
        if (err) return done.fail(err);

        var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

        expect(secondVersion).toEqual(firstVersion);
        done();
      });
    });
  });

  it("bakes a reserved global-static file from the global static directory, like lookupFile", function (done) {
    var path = "/Hello.txt";
    var contents =
      "![Icon](/icons/search.svg) ![Encoded](/ic%6Fns/search.svg?v=2#a)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    // A same-named file in the blog folder must not win over the global one.
    fs.outputFileSync(this.blogDirectory + "/icons/search.svg", "blog file");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toContain(`src="${BLOT_CDN_TOKEN}/icons/search.svg"`);
      expect(entry.html).toContain(
        `src="${BLOT_CDN_TOKEN}/icons/search.svg?v=2#a"`
      );
      expect(entry.html).not.toContain("/folder/v-");
      // Not a file in the blog's folder, so nothing to depend on.
      expect(entry.dependencies).not.toContain("/icons/search.svg");
      done();
    });
  });

  it("falls back to the blog folder when a reserved path isn't in the global static directory", function (done) {
    var path = "/Hello.txt";
    var contents = "![Font icon](fonts/icon.png) ![Missing](/katex/missing.png)";

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/fonts/icon.png", "blog file");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/fonts/icon\\.png"));
      expect(entry.html).toContain('src="/katex/missing.png"');
      expect(entry.dependencies).toContain("/fonts/icon.png");
      expect(entry.dependencies).toContain("/katex/missing.png");
      done();
    });
  });

  it("doesn't let a reserved-looking path escape the global static directory", function (done) {
    var path = "/Hello.txt";

    fs.outputFileSync(this.blogDirectory + path, "![Up](/icons/../layout.css)");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      // layout.css exists in the global static directory, but not under a
      // reserved prefix, and there is no such file in the blog folder.
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

  it("records a missing file's path as authored, for the case-insensitive dependents key", function (done) {
    var path = "/Hello.txt";

    fs.outputFileSync(this.blogDirectory + path, "![Pic](/Photo.JPG)");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
      expect(entry.dependencies).toContain("/Photo.JPG");
      done();
    });
  });

  it("decodes the path of a missing poster and srcset file before recording it as a dependency", function (done) {
    var path = "/Hello.txt";
    var contents =
      '<video poster="/my%20pic.jpg"></video>\n\n' +
      '<img src="/a.jpg" srcset="/a.jpg 1x, /big%20pic.jpg 2x, /50%zz.jpg 3x">';

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.dependencies).toContain("/my pic.jpg");
      expect(entry.dependencies).toContain("/big pic.jpg");
      // a value which can't be decoded is recorded unchanged
      expect(entry.dependencies).toContain("/50%zz.jpg");
      expect(entry.dependencies).not.toContain("/my%20pic.jpg");
      done();
    });
  });

  describe("bakeHTML (front matter markup overrides)", function () {
    var bakeHTML = require("../index").bakeHTML;

    it("bakes a string and returns the dependencies, leaving an untouched string as it was", async function () {
      fs.outputFileSync(this.blogDirectory + "/photo.jpg", "fake image data");

      var options = {
        blogID: this.blog.id,
        handle: this.blog.handle,
        domain: this.blog.domain,
        path: "/Hello.txt",
      };

      var baked = await bakeHTML(
        '<p><img src="/photo.jpg"> <a href="/missing%20one.pdf">x</a></p>',
        options
      );

      expect(baked.html).toMatch(tokenRegex("/photo\\.jpg"));
      expect(baked.dependencies).toContain("/photo.jpg");
      expect(baked.dependencies).toContain("/missing one.pdf");

      var untouched = "<p>Hello<br>there</p>";

      expect((await bakeHTML(untouched, options)).html).toEqual(untouched);
    });

    it("bakes teaser and teaserBody set by front matter and records their dependencies", function (done) {
      var path = "/Hello.md";
      var contents =
        "---\n" +
        "teaser: '<img src=\"/photo.jpg\">'\n" +
        "teaserBody: '<a href=\"/photo.jpg\">Photo</a> <a href=\"/later.pdf\">Later</a>'\n" +
        "---\n\n" +
        "Body text";

      fs.outputFileSync(this.blogDirectory + path, contents);
      fs.outputFileSync(this.blogDirectory + "/photo.jpg", "fake image data");

      build(this.blog, path, function (err, entry) {
        if (err) return done.fail(err);

        expect(entry.teaser).toMatch(tokenRegex("/photo\\.jpg"));
        expect(entry.teaserBody).toMatch(tokenRegex("/photo\\.jpg"));
        expect(entry.teaserBody).toContain('href="/later.pdf"');
        expect(entry.dependencies).toContain("/photo.jpg");
        expect(entry.dependencies).toContain("/later.pdf");
        done();
      });
    });
  });
});
