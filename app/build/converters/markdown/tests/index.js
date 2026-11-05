const fs = require("fs-extra");
const markdown = require("build/converters/markdown/index");

describe("markdown converter", function () {
  global.test.blog();
  const dir = __dirname + "/examples";

  fs.readdirSync(dir)
    .filter((file) => file.slice(-4) === ".txt")
    .forEach((file) => {
      it("handles " + file.slice(0, -4).split("-").join(" "), async function () {
        // Copy the .bib and csl files to the root of the blog folder
        await test.folder.copyDirectory(this.blog.id, dir + "/files");
        await test.folder.copyDirectory(this.blog.id, dir);

        const path = "/" + file;
        let html = await new Promise((resolve, reject) => {
          markdown.read(this.blog, path, function (err, html) {
            if (err) return reject(err);
            resolve(html);
          });
        });

        {
          let expected;

          try {
            html = html.replace(
              /"#?footnote-[A-Z\d]{1,6}"/gm,
              '"#footnote-ID_REMOVED"'
            );
            html = html.replace(/"#?ref-[A-Z\d]{1,6}"/gm, '"#ref-ID_REMOVED"');

            expected = fs.readFileSync(dir + path + ".html", "utf8");
            expected = expected.replace(
              /"#?footnote-[A-Z\d]{1,6}"/gm,
              '"#footnote-ID_REMOVED"'
            );
            expected = expected.replace(
              /"#?ref-[A-Z\d]{1,6}"/gm,
              '"#ref-ID_REMOVED"'
            );
          } catch (e) {
            console.log(e);
            fs.outputFileSync(dir + path + ".expected.html", html);
          }

          if (html !== expected)
            fs.outputFileSync(dir + path + ".expected.html", html);

          expect(expected).toEqual(html);
        }
      });
    });
});
