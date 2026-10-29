const Plugins = require("build/plugins");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

describe("plugin public CSS", function () {
  it("points links to Blot's global static files at the CDN", function () {
    const css = Plugins.list.katex.publicCSS;

    expect(css).toContain(
      "url(" + BLOT_CDN_TOKEN + "/plugins/katex/files/KaTeX_AMS-Regular.woff2)"
    );
    expect(css).not.toMatch(/url\(\s*['"]?\/plugins\//);
  });
});
