describe("storage/assets", function () {
  global.test.blog();

  var assets = require("storage/assets");
  var config = require("config");
  var fs = require("fs-extra");
  var join = require("path").join;

  it("joins a path inside the blog's asset directory", function () {
    var test = this;
    var expected = join(
      config.blog_static_files_dir,
      test.blog.id,
      "_thumbnails",
      "foo.jpg"
    );

    expect(assets.path(test.blog.id, "_thumbnails", "foo.jpg")).toEqual(
      expected
    );
  });

  it("returns the blog's root directory when called with no segments", function () {
    var test = this;
    var expected = join(config.blog_static_files_dir, test.blog.id);

    expect(assets.path(test.blog.id)).toEqual(expected);
  });

  it("rejects a path which escapes the blog's asset directory", function () {
    var test = this;

    expect(function () {
      assets.path(test.blog.id, "../x");
    }).toThrow();

    expect(function () {
      assets.path(test.blog.id, "../../");
    }).toThrow();
  });

  it("rejects a blogID which is not a non-empty string", function () {
    expect(function () {
      assets.path("", "x");
    }).toThrow();

    expect(function () {
      assets.path(undefined, "x");
    }).toThrow();
  });

  it("removeAll removes the blog's entire asset directory", function (done) {
    var test = this;
    var root = assets.path(test.blog.id);
    var path = join(root, "_thumbnails", "foo.jpg");

    fs.outputFile(path, "hello", function (err) {
      if (err) return done.fail(err);

      assets.removeAll(test.blog.id).then(function () {
        fs.pathExists(root, function (err, exists) {
          if (err) return done.fail(err);
          expect(exists).toBe(false);
          done();
        });
      }, done.fail);
    });
  });

  it("removeAll is a no-op when the directory does not exist", function (done) {
    var test = this;

    assets.removeAll(test.blog.id).then(function () {
      assets.removeAll(test.blog.id).then(function () {
        done();
      }, done.fail);
    }, done.fail);
  });
});
