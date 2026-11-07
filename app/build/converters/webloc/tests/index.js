const webloc = require("../index");
const folder = require("storage/folder");

describe("webloc converter", function () {
  global.test.blog();

  // Resolves to { err, result }
  async function read(blog, path) {
    try {
      const [result] = await webloc.read(blog, path);
      return { err: null, result: result };
    } catch (err) {
      return { err: err, result: undefined };
    }
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

  it("returns an error when the file does not exist", async function () {
    const test = this;
    const path = "/does-not-exist.webloc";

    const { err, result } = await read(test.blog, path);
    expect(err).toBeTruthy();
    expect(result).toBeUndefined();
  });

  it("recognizes .webloc and .url paths and rejects others", function () {
    expect(webloc.is("/file.webloc")).toBe(true);
    expect(webloc.is("/file.WEBLOC")).toBe(true);
    expect(webloc.is("/file.url")).toBe(true);
    expect(webloc.is("/file.URL")).toBe(true);
    expect(webloc.is("/file.txt")).toBe(false);
  });
});
