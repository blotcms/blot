const fs = require("fs-extra");
const org = require("build/converters/org/index");

describe("org converter", function () {
  global.test.blog();
  const dir = __dirname + "/examples";

  fs.readdirSync(dir)
    .filter((file) => org.is(file))
    .forEach((file) => {
      it("handles " + file.slice(0, -4).split("-").join(" "), async function () {
        // Copy the .bib and csl files to the root of the blog folder
        await test.folder.copyDirectory(this.blog.id, dir);

        const path = "/" + file;
        const html = await new Promise((resolve, reject) => {
          org.read(this.blog, path, function (err, html) {
            if (err) return reject(err);
            resolve(html);
          });
        });

        {
          let expected;

          try {
            expected = fs.readFileSync(dir + path + ".html", "utf8");
          } catch (e) { }

          if (html !== expected)
            fs.outputFileSync(dir + path + ".expected.html", html);

          expect(expected).toEqual(html);
        }
      });
    });
});
