const webloc = require("../index");
const folder = require("storage/folder");

describe("webloc converter", function () {
  global.test.blog();

  // Resolves to { err, result }
  function read(blog, path) {
    return new Promise(function (resolve) {
      webloc.read(blog, path, function (err, result) {
        resolve({ err: err, result: result });
      });
    });
  }

  it("extracts a URL from an XML webloc file (Chrome/Firefox format)", async function () {
    const test = this;
    const path = "/link.webloc";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    const { err, result } = await read(test.blog, path);
    if (err) throw err;
    expect(result).toEqual(
      '<p><a href="https://example.com/xml-bookmark" class="bookmark">link</a></p>'
    );
  });

  it("extracts a URL from a binary plist webloc file (Safari format)", async function () {
    const test = this;
    const path = "/safari.webloc";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    const { err, result } = await read(test.blog, path);
    if (err) throw err;
    expect(result).toEqual(
      '<p><a href="https://example.com/safari-bookmark" class="bookmark">safari</a></p>'
    );
  });

  it("extracts a URL from a Windows .url InternetShortcut file", async function () {
    const test = this;
    const path = "/shortcut.url";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    const { err, result } = await read(test.blog, path);
    if (err) throw err;
    expect(result).toEqual(
      '<p><a href="https://example.com/windows-shortcut" class="bookmark">shortcut</a></p>'
    );
  });

  it("returns an error for a file which is not a valid webloc, bplist or InternetShortcut", async function () {
    const test = this;
    const path = "/invalid.webloc";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    const { err, result } = await read(test.blog, path);
    expect(err).toBeTruthy();
    expect(err.message).toEqual("Invalid webloc file");
    expect(result).toBeUndefined();
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
