const docx = require("../index");
const fs = require("fs-extra");

describe("docx converter", function () {
  global.test.blog();

  const tests = fs
    .readdirSync(__dirname)
    .filter((i) => i.slice(-5) === ".docx");

  tests.forEach((name) => {
    it("converts docx with " + name, function (done) {
      const test = this;
      const path = "/" + name;
      const expected = fs.readFileSync(__dirname + path + ".html", "utf8");

      fs.copySync(__dirname + path, test.blogDirectory + path);

      docx.read(test.blog, path, function (err, result) {
        if (err) return done.fail(err);
        expect(result).toEqual(expected);
        done();
      });
    });
  });

  it("does not execute shell substitutions in filenames", function (done) {
    const test = this;
    const name = "paragraph$(touch docx-shell-substitution).docx";
    const path = "/" + name;
    const marker = process.cwd() + "/docx-shell-substitution";
    const expected = fs.readFileSync(
      __dirname + "/paragraph.docx.html",
      "utf8"
    );

    fs.removeSync(marker);
    fs.copySync(__dirname + "/paragraph.docx", test.blogDirectory + path);

    docx.read(test.blog, path, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(expected);
      expect(fs.existsSync(marker)).toBe(false);
      done();
    });
  });

  it("returns an error when the file is not a valid docx", function (done) {
    const test = this;
    const path = "/corrupt.docx";

    fs.writeFileSync(test.blogDirectory + path, "this is not a docx file");

    docx.read(test.blog, path, function (err, result) {
      expect(err).toBeTruthy();
      expect(err.message).toContain("Pandoc exited");
      expect(result).toBeUndefined();
      done();
    });
  });

  it("recognizes .docx paths and rejects others", function () {
    expect(docx.is("/file.docx")).toBe(true);
    expect(docx.is("/file.DOCX")).toBe(true);
    expect(docx.is("/file.odt")).toBe(false);
  });
});
