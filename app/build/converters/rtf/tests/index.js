const fs = require("fs-extra");
const rtf = require("build/converters/rtf/index");

describe("rtf converter", function () {
  global.test.blog();
  const dir = __dirname + "/examples";

  fs.readdirSync(dir)
    .filter((file) => rtf.is(file))
    .forEach((file) => {
      it(
        "handles " + file.slice(0, -4).split("-").join(" "),
        async function () {
          // Copy the .bib and csl files to the root of the blog folder
          await test.folder.copyDirectory(this.blog.id, dir);

          const path = "/" + file;
          const [html] = await rtf.read(this.blog, path);

          {
            let expected;

            try {
              expected = fs.readFileSync(dir + path + ".html", "utf8");
            } catch (e) {}

            if (html !== expected)
              fs.outputFileSync(dir + path + ".expected.html", html);

            expect(expected).toEqual(html);
          }
        }
      );
    });
});
