const fs = require("fs-extra");
const build = require("build");
const templates = require("templates");

const SINGLE_SPEC="";

// Build the templates
beforeAll(function (done) {
  templates({ watch: false }, done);
}, 10 * 1000); // longer timeout

describe("katex plugin integration", function () {
  require("build/tests/plugins/util/setup")();

  const dir = __dirname + "/examples";
  const supportedExtensions = [".txt", ".md", ".gdoc", ".rtf"];

  fs.readdirSync(dir)
    .filter((file) => supportedExtensions.some((ext) => file.endsWith(ext)))
    .filter((file) => SINGLE_SPEC ? file === SINGLE_SPEC : true)
    .forEach((file) => {
      it("handles " + file.split("-").join(" "), function (done) {
        const path = "/" + file;
        const contents = fs.readFileSync(dir + path, "utf8");
        const expectedPath = dir + path + ".html";
        let expected;

        try {
          expected = fs.readFileSync(expectedPath, "utf8");
        } catch (e) {}

        test.folder.writeFiles(this.blog.id, { [path]: contents }).then(() => {
          build(this.blog, path, (err, entry) => {
            if (err) return done.fail(err);
            const html = entry.html;

            if (html !== expected) {
              fs.outputFileSync(expectedPath + ".expected.html", html);
            }

            expect(expected).toEqual(html);
            done();
          });
        }, done.fail);
      });
    });
});

afterAll(function () {
  console.log(
    "\nTo visually confirm KaTeX output for test fixtures, run the preview server:"
  );
  console.log("node app/build/plugins/katex/preview.js");
});
