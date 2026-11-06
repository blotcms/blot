describe("gdoc", function () {
  require("../../util/setup")();

  const fs = require("fs-extra");

  const specs = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith(".gdoc"));

  specs.forEach((file) => {
    it("processes " + file, async function () {
      await this.template({
        "entries.html": "{{#entries}}{{{url}}}{{/entries}}",
        "entry.html": "{{{entry.html}}}",
      });

      await this.write({
        path: "/" + file,
        content: fs.readFileSync(__dirname + "/" + file),
      });

      const url = await this.text("/");

      const expected = fs.readFileSync(
        __dirname + "/" + file + ".html",
        "utf8"
      );

      const result = await this.text(url);

      if (result !== expected) {
        console.log("result does not match expected:");
        console.log("result:");
        console.log(result);
        console.log("expected:");
        console.log(expected);
      }

      expect(result).toEqual(expected, "result does not match expected");
    });
  });
});
