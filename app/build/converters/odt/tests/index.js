const odt = require("../index");
const fs = require("fs-extra");
const folder = require("storage/folder");

// Resolves to { err, result } so specs can assert on failures too
function read(blog, path) {
  return new Promise(function (resolve) {
    odt.read(blog, path, function (err, result) {
      resolve({ err: err, result: result });
    });
  });
}

describe("odt converter", function () {
  global.test.blog();

  const tests = fs.readdirSync(__dirname).filter(i => i.slice(-4) === ".odt");

  tests.forEach(name => {
    it("converts odt with " + name, async function () {
      const test = this;
      const path = "/" + name;
      const expected = fs.readFileSync(__dirname + path + ".html", "utf8");

      await folder.writeFrom(test.blog.id, path, __dirname + path);

      const { err, result } = await read(test.blog, path);
      if (err) throw err;
      expect(result).toEqual(expected);
      if (result !== expected) {
        fs.writeFileSync(__dirname + "/" + name + "result.html", result);
      }
    });
  });

  it("does not execute shell substitutions in filenames", async function () {
    const test = this;
    const name = "paragraph$(touch odt-shell-substitution).odt";
    const path = "/" + name;
    const marker = process.cwd() + "/odt-shell-substitution";
    const expected = fs.readFileSync(
      __dirname + "/paragraph.odt.html",
      "utf8"
    );

    fs.removeSync(marker);
    await folder.writeFrom(test.blog.id, path, __dirname + "/paragraph.odt");

    const { err, result } = await read(test.blog, path);
    if (err) throw err;
    expect(result).toEqual(expected);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("returns an error when the file is not a valid odt", async function () {
    const test = this;
    const path = "/corrupt.odt";

    await folder.write(test.blog.id, path, "this is not an odt file");

    const { err, result } = await read(test.blog, path);
    expect(err).toBeTruthy();
    expect(err.message).toContain("Pandoc exited");
    expect(result).toBeUndefined();
  });

  it("recognizes .odt paths and rejects others", function () {
    expect(odt.is("/file.odt")).toBe(true);
    expect(odt.is("/file.ODT")).toBe(true);
    expect(odt.is("/file.docx")).toBe(false);
  });
});
