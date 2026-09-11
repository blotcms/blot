const webloc = require("../index");
const fs = require("fs-extra");

describe("webloc converter", function () {
  global.test.blog();

  it("extracts a URL from an XML webloc file (Chrome/Firefox format)", function (done) {
    const test = this;
    const path = "/link.webloc";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    webloc.read(test.blog, path, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(
        '<p><a href="https://example.com/xml-bookmark" class="bookmark">link</a></p>'
      );
      done();
    });
  });

  it("extracts a URL from a binary plist webloc file (Safari format)", function (done) {
    const test = this;
    const path = "/safari.webloc";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    webloc.read(test.blog, path, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(
        '<p><a href="https://example.com/safari-bookmark" class="bookmark">safari</a></p>'
      );
      done();
    });
  });

  it("extracts a URL from a Windows .url InternetShortcut file", function (done) {
    const test = this;
    const path = "/shortcut.url";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    webloc.read(test.blog, path, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(
        '<p><a href="https://example.com/windows-shortcut" class="bookmark">shortcut</a></p>'
      );
      done();
    });
  });

  it("returns an error for a file which is not a valid webloc, bplist or InternetShortcut", function (done) {
    const test = this;
    const path = "/invalid.webloc";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    webloc.read(test.blog, path, function (err, result) {
      expect(err).toBeTruthy();
      expect(err.message).toEqual("Invalid webloc file");
      expect(result).toBeUndefined();
      done();
    });
  });

  it("returns an error when the file does not exist", function (done) {
    const test = this;
    const path = "/does-not-exist.webloc";

    webloc.read(test.blog, path, function (err, result) {
      expect(err).toBeTruthy();
      expect(result).toBeUndefined();
      done();
    });
  });

  it("recognizes .webloc and .url paths and rejects others", function () {
    expect(webloc.is("/file.webloc")).toBe(true);
    expect(webloc.is("/file.WEBLOC")).toBe(true);
    expect(webloc.is("/file.url")).toBe(true);
    expect(webloc.is("/file.URL")).toBe(true);
    expect(webloc.is("/file.txt")).toBe(false);
  });
});
