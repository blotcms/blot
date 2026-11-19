describe("blog/lib/staticVersion", function () {
  const crypto = require("crypto");
  const fs = require("fs");
  const { GLOBAL_STATIC_DIR } = require("blog/lib/staticPaths");
  const { staticVersion, staticSuffix } = require("blog/lib/staticVersion");

  const PATH = "/icons/search.svg";
  const VERSION = crypto
    .createHash("sha256")
    .update(fs.readFileSync(GLOBAL_STATIC_DIR + PATH))
    .digest("hex")
    .slice(0, 8);

  it("is a hash of the file's bytes", function () {
    expect(staticVersion(PATH)).toBe(VERSION);
  });

  it("is null for a missing file, or a path that isn't reserved", function () {
    expect(staticVersion("/icons/missing.svg")).toBe(null);
    expect(staticVersion("/fonts/../package.json")).toBe(null);
    expect(staticVersion("/style.css")).toBe(null);
  });

  it("adds the version before a #hash", function () {
    expect(staticSuffix(PATH)).toBe("?version=" + VERSION);
    expect(staticSuffix(PATH, "#a")).toBe("?version=" + VERSION + "#a");
  });

  it("keeps a link's own query as written", function () {
    expect(staticSuffix(PATH, "?v=2#a")).toBe("?v=2#a");
  });

  it("leaves a link to a missing file alone", function () {
    expect(staticSuffix("/icons/missing.svg", "#a")).toBe("#a");
  });
});
