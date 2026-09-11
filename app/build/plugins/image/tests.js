describe("image", function () {
  global.test.blog();

  var image = require("./index");
  var cheerio = require("cheerio");
  var fs = require("fs-extra");
  var localPath = require("helper/localPath");
  var config = require("config");
  var join = require("path").join;
  var crypto = require("crypto");
  var sharp = require("sharp");

  afterEach(function () {
    if (!this.result) return;
    verifyCachedImagesExist(extractCachedImagePaths(this.blog, this.result));
  });

  it("returns a different cached image when source image is modified", function (done) {
    var test = this;
    var image = "/tests-image.png";
    var modifiedImage = "/tests-image-modified.png";
    var html = '<img src="' + image + '">';

    fs.copySync(__dirname + image, localPath(test.blog.id, image));

    render(test.blog, html, function (err, firstResult) {
      expect(err).toBe(null);

      fs.copySync(__dirname + modifiedImage, localPath(test.blog.id, image));

      render(test.blog, html, function (err, secondResult) {
        expect(err).toBe(null);

        expect(firstResult).toContain("/_image_cache/");
        expect(secondResult).toContain("/_image_cache/");
        expect(firstResult).not.toEqual(secondResult);

        test.result = secondResult;
        done();
      });
    });
  });

  it("will preserve the color profile of the image", function (done) {
    var test = this;
    var image = "/tests-p3.jpg";
    var html = '<img src="' + image + '">';

    fs.copySync(__dirname + image, localPath(test.blog.id, image));

    render(test.blog, html, function (err, result) {
      if (err) return done.fail(err);

      var path = extractCachedImagePaths(test.blog, result)[0];

      sharp(path).metadata(function (err, metadata) {
        if (err) return done.fail(err);

        expect(metadata.icc).toBeDefined();
        expect(metadata.icc).toContain('P3'); // Ensure it is preserved

        done();
      });
    });
  });

  it("will fetch dimensions of GIFs but will not resize them", function (done) {
    var test = this;
    var image = "/tests-image.gif";
    var html = '<img src="' + image + '">';

    fs.copySync(__dirname + image, localPath(test.blog.id, image));

    render(test.blog, html, function (err, result) {
      if (err) return done.fail(err);

      expect(result).toContain("/_image_cache/");

      // Image cache retrieves dimensions of images that it
      // does not resize or modify
      expect(result).toContain('width="450" height="338"');

      var path = extractCachedImagePaths(test.blog, result)[0];

      var cachedContentHash = crypto
        .createHash("sha1")
        .update(fs.readFileSync(path))
        .digest("hex");

      var originalContentHash = crypto
        .createHash("sha1")
        .update(fs.readFileSync(__dirname + image))
        .digest("hex");

      expect(originalContentHash).toEqual(cachedContentHash);
      test.result = result;
      done();
    });
  });

  it("returns the same cached image when re-run", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var html = '<img src="' + path + '">';
    var blog = test.blog;
    fs.copySync(__dirname + path, localPath(test.blog.id, path));

    render(blog, html, function (err, firstResult) {
      render(blog, html, function (err, secondResult) {
        expect(firstResult).toContain("/_image_cache/");
        expect(secondResult).toContain("/_image_cache/");
        expect(firstResult).toEqual(secondResult);
        test.result = secondResult;
        done();
      });
    });
  });

  it("downsizes large images", function (done) {
    var test = this;
    var large = "/tests-large-image.jpg";
    var html = '<img src="' + large + '">';

    fs.copySync(__dirname + large, localPath(test.blog.id, large));

    require("sharp")(__dirname + large).metadata(function (err, originalInfo) {
      if (err) return done.fail(err);

      render(test.blog, html, function (err, result) {
        if (err) return done.fail(err);

        var image = extractCachedImagePaths(test.blog, result)[0];

        require("sharp")(image).metadata(function (err, cachedInfo) {
          if (err) return done.fail(err);

          // Ensure cached image is smaller than 3000 x 3000 pixels
          expect(cachedInfo.width <= 3000).toBe(true);
          expect(cachedInfo.height <= 3000).toBe(true);

          // Ensure cached image is same aspect ratio as original
          expect(Math.floor(cachedInfo.height / cachedInfo.width)).toEqual(
            Math.floor(originalInfo.height / originalInfo.width)
          );

          test.result = result;
          done();
        });
      });
    });
  });

  it("caches an image", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var html = '<img src="' + path + '">';

    fs.copySync(__dirname + path, localPath(test.blog.id, path));

    render(test.blog, html, function (err, result) {
      expect(result).toContain(".png");
      expect(result).toContain("/_image_cache/");
      test.result = result;
      done();
    });
  });

  it("resolves an image referenced by its own blot.im subdomain URL from disk instead of fetching it", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var src = "https://" + test.blog.handle + "." + config.host + path;
    var html = '<img src="' + src + '">';

    fs.copySync(__dirname + path, localPath(test.blog.id, path));

    render(test.blog, html, function (err, result) {
      expect(err).toBe(null);
      expect(result).toContain(".png");
      expect(result).toContain("/_image_cache/");
      test.result = result;
      done();
    });
  });

  it("resolves an image referenced by its own custom domain URL, ignoring the query string", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var src = "https://www.example.com" + path + "?foo=bar";
    var html = '<img src="' + src + '">';

    fs.copySync(__dirname + path, localPath(test.blog.id, path));

    test.blog.update({ domain: "example.com" }).then(function () {
      // .update() writes to Redis but doesn't mutate this in-memory
      // object, so reflect the change the way a fresh blog.get() would.
      test.blog.domain = "example.com";

      render(test.blog, html, function (err, result) {
        expect(err).toBe(null);
        expect(result).toContain(".png");
        expect(result).toContain("/_image_cache/");
        test.result = result;
        done();
      });
    });
  });

  it("resolves an image referenced by its own domain URL case-insensitively", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var src =
      "https://" + test.blog.handle + "." + config.host + "/NESTED" + path.toUpperCase();
    var html = '<img src="' + src + '">';

    fs.copySync(__dirname + path, localPath(test.blog.id, "/nested" + path));

    render(test.blog, html, function (err, result) {
      expect(err).toBe(null);
      expect(result).toContain(".png");
      expect(result).toContain("/_image_cache/");
      test.result = result;
      done();
    });
  });

  it("caches an image case-insensitively", function (done) {
    var test = this;
    var path = "/tests-image.png";
    var html = '<img src="/nested/' + path.toUpperCase() + '">';

    fs.copySync(__dirname + path, localPath(test.blog.id, "/nested" + path));

    render(test.blog, html, function (err, result) {
      expect(result).toContain(".png");
      expect(result).toContain("/_image_cache/");
      test.result = result;
      done();
    });
  });

  function extractCachedImagePaths (blog, html) {
    var paths = [];
    var $ = cheerio.load(html, null, false);

    $("img").each(function () {
      var src = $(this).attr("src");
      var path;

      if (src.indexOf(config.cdn.origin) === 0) {
        src = src.slice(config.cdn.origin.length);
        path = join(config.blog_static_files_dir, src);
      } else {
        path = join(config.blog_static_files_dir, blog.id, src);
      }

      paths.push(path);
    });

    return paths;
  }

  function verifyCachedImagesExist (imagePaths) {
    imagePaths.forEach(function (path) {
      try {
        // Does the cached image exist on disk?
        var stat = fs.statSync(path);
        expect(stat.isFile()).toEqual(true);
      } catch (e) {
        return fail(e);
      }
    });
  }

  // Wrapper around dumb API for this plugin
  function render (blog, html, callback) {
    var options = {
      blogID: blog.id,
      domain: blog.domain,
      baseURL: "https://" + blog.handle + "." + config.host
    };
    var $ = cheerio.load(html, null, false);

    image.render(
      $,
      function () {
        callback(null, $.html());
      },
      options
    );
  }
});
