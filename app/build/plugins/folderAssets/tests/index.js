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

  it("percent-encodes the baked path so a space doesn't split a srcset candidate", function (done) {
    var { parseSrcset } = require("blog/render/replaceFolderLinks/shared");
    var path = "/Hello.txt";
    var contents = '<img src="/my pic.jpg" srcset="/my%20pic.jpg 1x, /big%20pic.jpg 2x">';

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/my pic.jpg", "small");
    fs.outputFileSync(this.blogDirectory + "/big pic.jpg", "big");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      var srcset = entry.html.match(/srcset="([^"]*)"/)[1];
      var candidates = parseSrcset(srcset);

      expect(candidates.length).toEqual(2);
      expect(candidates[0].url).toMatch(tokenRegex("/my%20pic\\.jpg$"));
      expect(candidates[0].descriptor).toEqual("1x");
      expect(candidates[1].url).toMatch(tokenRegex("/big%20pic\\.jpg$"));
      expect(candidates[1].descriptor).toEqual("2x");
      expect(entry.html).toMatch(new RegExp('src="' + tokenRegex("/my%20pic\\.jpg").source + '"'));
      expect(entry.dependencies).toContain("/my pic.jpg");
      expect(entry.dependencies).toContain("/big pic.jpg");
      done();
    });
  });

  it("keeps an encoded '#' or '?' in a file name part of the path", function (done) {
    var path = "/Hello.txt";

    fs.outputFileSync(this.blogDirectory + path, `<img src="/it's%20%231%3F.jpg?w=1#top">`);
    fs.outputFileSync(this.blogDirectory + "/it's #1?.jpg", "image");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(tokenRegex("/it%27s%20%231%3F\\.jpg\\?w=1#top\""));
      expect(entry.dependencies).toContain("/it's #1?.jpg");
      done();
    });
  });

  it("re-bakes an already-baked encoded srcset, keeping a missing file's path encoded", function (done) {
    var path = "/Hello.txt";
    var baked = (file) => `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${this.blog.id}${file}`;
    var contents = `<img srcset="${baked("/my%20pic.jpg")} 2x, ${baked("/gone%20pic.jpg")} 1x">`;

    fs.outputFileSync(this.blogDirectory + path, contents);
    fs.outputFileSync(this.blogDirectory + "/my pic.jpg", "small");

    build(this.blog, path, function (err, entry) {
      if (err) return done.fail(err);

      expect(entry.html).toMatch(
        new RegExp('srcset="' + tokenRegex("/my%20pic\\.jpg 2x").source + ', /gone%20pic\\.jpg 1x"')
      );
      expect(entry.html).not.toContain("v-deadbeef");
      expect(entry.dependencies).toContain("/my pic.jpg");
      expect(entry.dependencies).toContain("/gone pic.jpg");
      done();
    });
  });
});
