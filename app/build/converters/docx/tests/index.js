const docx = require("../index");
const fs = require("fs-extra");
const folder = require("storage/folder");

// Resolves to { err, result } so specs can assert on failures too
function read(blog, path) {
  return new Promise(function (resolve) {
    docx.read(blog, path, function (err, result) {
      resolve({ err: err, result: result });
    });
  });
}

describe("docx converter", function () {
  global.test.blog();

  const tests = fs
    .readdirSync(__dirname)
    .filter((i) => i.slice(-5) === ".docx");

  tests.forEach((name) => {
    it("converts docx with " + name, async function () {
      const test = this;
      const path = "/" + name;
      const expected = fs.readFileSync(__dirname + path + ".html", "utf8");

      await folder.writeFrom(test.blog.id, path, __dirname + path);

      const { err, result } = await read(test.blog, path);
      if (err) throw err;
      expect(result).toEqual(expected);
    });
  });

  it("does not execute shell substitutions in filenames", async function () {
    const test = this;
    const name = "paragraph$(touch docx-shell-substitution).docx";
    const path = "/" + name;
    const marker = process.cwd() + "/docx-shell-substitution";
    const expected = fs.readFileSync(
      __dirname + "/paragraph.docx.html",
      "utf8"
    );

    fs.removeSync(marker);
    await folder.writeFrom(test.blog.id, path, __dirname + "/paragraph.docx");

    const { err, result } = await read(test.blog, path);
    if (err) throw err;
    expect(result).toEqual(expected);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("returns an error when the file is not a valid docx", async function () {
    const test = this;
    const path = "/corrupt.docx";

    await folder.write(test.blog.id, path, "this is not a docx file");

    const { err, result } = await read(test.blog, path);
    expect(err).toBeTruthy();
    expect(err.message).toContain("Pandoc exited");
    expect(result).toBeUndefined();
  });

  it("recognizes .docx paths and rejects others", function () {
    expect(docx.is("/file.docx")).toBe(true);
    expect(docx.is("/file.DOCX")).toBe(true);
    expect(docx.is("/file.odt")).toBe(false);
  });
});
