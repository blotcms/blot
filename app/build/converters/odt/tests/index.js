const odt = require("../index");
const fs = require("fs-extra");

describe("odt converter", function () {
  global.test.blog();

  const tests = fs.readdirSync(__dirname).filter(i => i.slice(-4) === ".odt");

  tests.forEach(name => {
    it("converts odt with " + name, function (done) {
      const test = this;
      const path = "/" + name;
      const expected = fs.readFileSync(__dirname + path + ".html", "utf8");

      fs.copySync(__dirname + path, test.blogDirectory + path);

      odt.read(test.blog, path, function (err, result) {
        if (err) return done.fail(err);
        expect(result).toEqual(expected);
        if (result !== expected) {
          fs.writeFileSync(__dirname + "/" + name + "result.html", result);
        }
        done();
      });
    });
  });

  it("does not execute shell substitutions in filenames", function (done) {
    const test = this;
    const name = "paragraph$(touch odt-shell-substitution).odt";
    const path = "/" + name;
    const marker = process.cwd() + "/odt-shell-substitution";
    const expected = fs.readFileSync(
      __dirname + "/paragraph.odt.html",
      "utf8"
    );

    fs.removeSync(marker);
    fs.copySync(__dirname + "/paragraph.odt", test.blogDirectory + path);

    odt.read(test.blog, path, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(expected);
      expect(fs.existsSync(marker)).toBe(false);
      done();
    });
  });

  it("returns an error when the file is not a valid odt", function (done) {
    const test = this;
    const path = "/corrupt.odt";

    fs.writeFileSync(test.blogDirectory + path, "this is not an odt file");

    odt.read(test.blog, path, function (err, result) {
      expect(err).toBeTruthy();
      expect(err.message).toContain("Pandoc exited");
      expect(result).toBeUndefined();
      done();
    });
  });

  it("recognizes .odt paths and rejects others", function () {
    expect(odt.is("/file.odt")).toBe(true);
    expect(odt.is("/file.ODT")).toBe(true);
    expect(odt.is("/file.docx")).toBe(false);
  });
});
