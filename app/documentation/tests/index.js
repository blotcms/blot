const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const config = require("config");
const build = require("documentation/build");

describe("Blot's documentation'", function () {

  global.test.site();
  global.test.timeout(5 * 60 * 1000); // Set timeout to 5 minutes

  it("has no broken links", async function () {
    await this.checkBrokenLinks();
  });

  it("refreshes generated tool pages after restoring a stale cache", async function () {
    const toolName = "__documentation-cache-startup-test";
    const sourcePath = path.join(
      config.blot_directory,
      "app/views/how/tools/text-editors",
      toolName + ".html"
    );
    const generatedPath = path.join(
      config.views_directory,
      "how/tools",
      toolName,
      "index.html"
    );
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      await fs.outputFile(sourcePath, "<h1>Cache Startup Test Tool</h1>");
      await fs.remove(generatedPath);

      const hash = await build.computeViewsHash();
      const cacheDirectory = path.join(
        tmpDirectory,
        "documentation-cache",
        hash,
        "views-built"
      );

      // Deliberately put the pre-tool-build output under the current hash.
      // This models a stale/incomplete cache that a startup must not trust.
      await fs.copy(config.views_directory, cacheDirectory);

      await build({ watch: false });

      const generated = await fs.readFile(generatedPath, "utf8");
      expect(generated).toContain("Cache Startup Test Tool");

      const refreshedCachePath = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built",
        "how/tools",
        toolName,
        "index.html"
      );

      expect(await fs.pathExists(refreshedCachePath)).toBe(true);
      expect(await fs.readFile(refreshedCachePath, "utf8")).toContain(
        "Cache Startup Test Tool"
      );
    } finally {
      config.tmp_directory = originalTmpDirectory;
      await fs.remove(sourcePath);
      await fs.remove(generatedPath);
      await fs.remove(tmpDirectory);
    }
  });

  it("updates changed tool pages and refreshes their cache", async function () {
    const toolName = "__documentation-cache-change-test";
    const sourcePath = path.join(
      config.blot_directory,
      "app/views/how/tools/text-editors",
      toolName + ".html"
    );
    const generatedPath = path.join(
      config.views_directory,
      "how/tools",
      toolName,
      "index.html"
    );
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      await fs.outputFile(sourcePath, "<h1>Cache Change Test Tool</h1>");
      await build.rebuildTools();

      await fs.outputFile(
        sourcePath,
        "<h1>Updated Cache Change Test Tool</h1>"
      );
      await build.rebuildTools();

      expect(await fs.readFile(generatedPath, "utf8")).toContain(
        "Updated Cache Change Test Tool"
      );

      const refreshedCachePath = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built",
        "how/tools",
        toolName,
        "index.html"
      );

      expect(await fs.readFile(refreshedCachePath, "utf8")).toContain(
        "Updated Cache Change Test Tool"
      );
    } finally {
      config.tmp_directory = originalTmpDirectory;
      await fs.remove(sourcePath);
      await fs.remove(generatedPath);
      await fs.remove(tmpDirectory);
    }
  });
});
