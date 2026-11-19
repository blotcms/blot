const Plugins = require("build/plugins");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const { staticVersion } = require("blog/lib/staticVersion");

describe("plugin public CSS", function () {
  it("points links to Blot's global static files at the CDN, versioned", function () {
    const css = Plugins.list.katex.publicCSS;
    const path = "/plugins/katex/files/KaTeX_AMS-Regular.woff2";

    expect(staticVersion(path)).toMatch(/^[a-f0-9]{8}$/);
    expect(css).toContain(
      "url(" + BLOT_CDN_TOKEN + path + "?version=" + staticVersion(path) + ")"
    );
    expect(css).not.toMatch(/url\(\s*['"]?\/plugins\//);
  });
});
