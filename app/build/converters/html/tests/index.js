const build = require("../../../index");
const folder = require("storage/folder");
const path = require("path");

describe("html converter metadata", function () {
  global.test.blog();

  ["bare-metadata.html", "yaml-metadata.html"].forEach(function (fixture) {
    it("preserves metadata before converting " + fixture, async function () {
      const entryPath = "/" + fixture;
      const source = path.join(__dirname, "fixtures", fixture);
      const blog = this.blog;

      await folder.writeFrom(blog.id, entryPath, source);
      const entry = await build(blog, entryPath);

      expect(entry.metadata.Title).toBe("Rock & Roll");
      expect(entry.metadata.Custom).toBe("1 < 2 &copy; 3 > 2");
      expect(entry.slug).toBe("rock-roll");

      expect(entry.html).not.toContain("Title: Rock");
      expect(entry.html).not.toContain("Custom:");
      expect(entry.html).not.toContain("---");
      expect(entry.html).toContain(
        '<div class="body">Body &amp; entity<br></div>'
      );
    });
  });
});
