const fs = require("fs");
const path = require("path");
const { legacyRules, RENAMED } = require("../build-css");

// The stylesheets build-css.js writes must match the installed katex: run it
// after a bump (node app/build/plugins/katex/build-css.js)
describe("katex stylesheets", function () {
  const root = path.resolve(__dirname, "../../../../..");
  const version = require("katex/package.json").version;
  const katexCSS = fs.readFileSync(
    require.resolve("katex/dist/katex.min.css"),
    "utf8"
  );
  const legacy = legacyRules(katexCSS);

  [
    "app/build/plugins/katex/public.css",
    "app/templates/source/magazine/css-katex.css",
    "app/views/css/tex.css",
  ].forEach((file) => {
    const css = fs.readFileSync(path.join(root, file), "utf8");

    it(file + " is the installed katex's stylesheet", function () {
      expect(css).toContain('content:"' + version + '"');
    });

    it(
      file + " styles the class names posts built before 0.18 use",
      function () {
        expect(css.replace(/\n/g, "")).toContain(legacy);
      }
    );
  });

  it("has a legacy rule for every renamed class", function () {
    for (const name of RENAMED) {
      expect(legacy).toMatch(new RegExp("\\." + name + "(?![\\w-])"));
    }
  });
});
