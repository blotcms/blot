describe("image", function () {
  global.test.blog();

  var image = require("./index");
  var cheerio = require("cheerio");
  var fs = require("fs-extra");
  var folder = require("storage/folder");
  var config = require("config");
  var assets = require("storage/assets");
  var crypto = require("crypto");
  var sharp = require("sharp");

  afterEach(async function () {
    if (!this.result) return;
    await verifyCachedImagesExist(
      this.blog,
      extractCachedImagePaths(this.blog, this.result)
    );
  });

  // Reads the metadata of an image on disk
  function metadata(path) {
    return sharp(path).metadata();
  }

  it("returns a different cached image when source image is modified", async function () {
    var image = "/tests-image.png";
    var modifiedImage = "/tests-image-modified.png";
    var html = '<img src="' + image + '">';

    await folder.writeFrom(this.blog.id, image, __dirname + image);

    var firstResult = await render(this.blog, html);

    await folder.writeFrom(this.blog.id, image, __dirname + modifiedImage);

    var secondResult = await render(this.blog, html);

    expect(firstResult).toContain("/_image_cache/");
    expect(secondResult).toContain("/_image_cache/");
    expect(firstResult).not.toEqual(secondResult);

    this.result = secondResult;
  });

  it("will preserve the color profile of the image", async function () {
    var image = "/tests-p3.jpg";
    var html = '<img src="' + image + '">';

    await folder.writeFrom(this.blog.id, image, __dirname + image);

    var result = await render(this.blog, html);
    var path = await assets.ensureLocal(
      this.blog.id,
      extractCachedImagePaths(this.blog, result)[0]
    );
    var info = await metadata(path);

    expect(info.icc).toBeDefined();
    expect(info.icc).toContain("P3"); // Ensure it is preserved
  });

  it("will fetch dimensions of GIFs but will not resize them", async function () {
    var image = "/tests-image.gif";
    var html = '<img src="' + image + '">';

    await folder.writeFrom(this.blog.id, image, __dirname + image);

    var result = await render(this.blog, html);

    expect(result).toContain("/_image_cache/");

    // Image cache retrieves dimensions of images that it
    // does not resize or modify
    expect(result).toContain('width="450" height="338"');

    var cached = await assets.read(
      this.blog.id,
      extractCachedImagePaths(this.blog, result)[0]
    );

    var cachedContentHash = crypto
      .createHash("sha1")
      .update(cached)
      .digest("hex");

    var originalContentHash = crypto
      .createHash("sha1")
      .update(fs.readFileSync(__dirname + image))
      .digest("hex");

    expect(originalContentHash).toEqual(cachedContentHash);
    this.result = result;
  });

  it("returns the same cached image when re-run", async function () {
    var path = "/tests-image.png";
    var html = '<img src="' + path + '">';
    var blog = this.blog;

    await folder.writeFrom(blog.id, path, __dirname + path);

    var firstResult = await render(blog, html);
    var secondResult = await render(blog, html);

    expect(firstResult).toContain("/_image_cache/");
    expect(secondResult).toContain("/_image_cache/");
    expect(firstResult).toEqual(secondResult);
    this.result = secondResult;
  });

  it("downsizes large images", async function () {
    var large = "/tests-large-image.jpg";
    var html = '<img src="' + large + '">';

    await folder.writeFrom(this.blog.id, large, __dirname + large);

    var originalInfo = await metadata(__dirname + large);
    var result = await render(this.blog, html);
    var image = await assets.ensureLocal(
      this.blog.id,
      extractCachedImagePaths(this.blog, result)[0]
    );
    var cachedInfo = await metadata(image);

    // Ensure cached image is smaller than 3000 x 3000 pixels
    expect(cachedInfo.width <= 3000).toBe(true);
    expect(cachedInfo.height <= 3000).toBe(true);

    // Ensure cached image is same aspect ratio as original
    expect(Math.floor(cachedInfo.height / cachedInfo.width)).toEqual(
      Math.floor(originalInfo.height / originalInfo.width)
    );

    this.result = result;
  });

  it("caches an image", async function () {
    var path = "/tests-image.png";
    var html = '<img src="' + path + '">';

    await folder.writeFrom(this.blog.id, path, __dirname + path);

    var result = await render(this.blog, html);

    expect(result).toContain(".png");
    expect(result).toContain("/_image_cache/");
    this.result = result;
  });

  it("resolves an image referenced by its own blot.im subdomain URL from disk instead of fetching it", async function () {
    var path = "/tests-image.png";
    var src = "https://" + this.blog.handle + "." + config.host + path;
    var html = '<img src="' + src + '">';

    await folder.writeFrom(this.blog.id, path, __dirname + path);

    var result = await render(this.blog, html);

    expect(result).toContain(".png");
    expect(result).toContain("/_image_cache/");
    this.result = result;
  });

  it("resolves an image referenced by its own custom domain URL, ignoring the query string", async function () {
    var path = "/tests-image.png";
    var src = "https://www.example.com" + path + "?foo=bar";
    var html = '<img src="' + src + '">';

    await folder.writeFrom(this.blog.id, path, __dirname + path);
    await this.blog.update({ domain: "example.com" });

    // .update() writes to Redis but doesn't mutate this in-memory
    // object, so reflect the change the way a fresh blog.get() would.
    this.blog.domain = "example.com";

    var result = await render(this.blog, html);

    expect(result).toContain(".png");
    expect(result).toContain("/_image_cache/");
    this.result = result;
  });

  it("resolves an image referenced by its own domain URL case-insensitively", async function () {
    var path = "/tests-image.png";
    var src =
      "https://" +
      this.blog.handle +
      "." +
      config.host +
      "/NESTED" +
      path.toUpperCase();
    var html = '<img src="' + src + '">';

    await folder.writeFrom(this.blog.id, "/nested" + path, __dirname + path);

    var result = await render(this.blog, html);

    expect(result).toContain(".png");
    expect(result).toContain("/_image_cache/");
    this.result = result;
  });

  it("caches an image case-insensitively", async function () {
    var path = "/tests-image.png";
    var html = '<img src="/nested/' + path.toUpperCase() + '">';

    await folder.writeFrom(this.blog.id, "/nested" + path, __dirname + path);

    var result = await render(this.blog, html);

    expect(result).toContain(".png");
    expect(result).toContain("/_image_cache/");
    this.result = result;
  });

  it("names cached images after the decoded filename and escapes their URLs", async function () {
    var name = "/说明.png";
    var html = '<img src="/%E8%AF%B4%E6%98%8E.png">';

    await folder.writeFrom(this.blog.id, name, __dirname + "/tests-image.png");

    var result = await render(this.blog, html);
    var src = cheerio.load(result, null, false)("img").attr("src");

    expect(src).toMatch(/\/_image_cache\/[0-9a-f-]+\/%E8%AF%B4%E6%98%8E\.png$/);
    this.result = result;
  });

  it("makes thumbnails from cached images with long escaped URLs", async function () {
    var thumbnail = require("build/thumbnail");
    var name = new Array(31).join("说") + ".png";
    var html = '<img src="/' + encodeURIComponent(name) + '">';

    await folder.writeFrom(
      this.blog.id,
      "/" + name,
      __dirname + "/tests-image.png"
    );

    var result = await render(this.blog, html);
    const thumbnails = await thumbnail(this.blog, "/post.txt", {}, result);

    expect(thumbnails).toEqual(jasmine.any(Object));
    expect(thumbnails.small).toEqual(jasmine.any(Object));
    this.result = result;
  });

  describe("filenameFromSrc", function () {
    var filenameFromSrc = require("./optimize").filenameFromSrc;

    it("decodes percent-encoded names", function () {
      expect(filenameFromSrc("/%E8%AF%B4%E6%98%8E.png")).toEqual(
        "\u8bf4\u660e"
      );
      expect(filenameFromSrc("/a%20b.jpg")).toEqual("a-b");
    });

    it("copes with sequences cut off mid-character", function () {
      expect(filenameFromSrc("/foo-%E2.png")).not.toContain("%E");
      expect(filenameFromSrc("/large.jpg%e2%80%9d")).not.toContain("%");
      expect(filenameFromSrc("/100%.png")).not.toContain("%");
    });

    it("keeps truncated names short once escaped", function () {
      var truncateSlug = require("./optimize").truncateSlug;

      expect(truncateSlug(new Array(61).join("a")).length).toEqual(50);
      expect(
        encodeURIComponent(truncateSlug(new Array(31).join("说"))).length
      ).not.toBeGreaterThan(150);
      expect(truncateSlug(new Array(31).join("😀"))).not.toContain("�");
    });

    it("does not leave replacement characters", function () {
      var long = new Array(60).join("%E8%AF%B4");
      expect(filenameFromSrc("/" + long + ".png")).not.toContain("\ufffd");
    });
  });

  // The cached images' paths in the blog's asset directory, e.g.
  // "_image_cache/{uuid}/name.jpg"
  function extractCachedImagePaths(blog, html) {
    var paths = [];
    var $ = cheerio.load(html, null, false);

    $("img").each(function () {
      var src = $(this).attr("src");

      if (src.indexOf(config.cdn.origin) === 0) {
        src = src.slice(config.cdn.origin.length);

        // /{blogID}/_image_cache/...
        src = src.slice(src.indexOf("/", 1));
      }

      paths.push(decodeURIComponent(src.replace(/^\//, "")));
    });

    return paths;
  }

  async function verifyCachedImagesExist(blog, imagePaths) {
    for (var path of imagePaths) {
      // Is the cached image in the bucket?
      expect(await assets.exists(blog.id, path)).toEqual(true);
    }
  }

  // Wrapper around dumb API for this plugin
  async function render(blog, html) {
    var options = {
      blogID: blog.id,
      domain: blog.domain,
      baseURL: "https://" + blog.handle + "." + config.host,
    };
    var $ = cheerio.load(html, null, false);

    await image.render($, options);

    return $.html();
  }
});
