describe("folderManifestUrl.locals", function () {
  const folderManifestUrl = require("../folderManifestUrl");
  const BLOT_CDN_TOKEN = require("../replaceFolderLinks/cdnToken");

  const request = (cdn) => ({
    blog: { id: "blog_1", handle: "example", domain: "" },
    template: { id: "blog_1:t", cdn },
  });

  const manifest = {
    "img/a.png": { path: "/img/a.png", version: "abc12345" },
    "style.css": "0123456789abcdef",
  };

  const cdnUrl = BLOT_CDN_TOKEN + "/folder/v-abc12345/blog_1/img/a.png";

  it("swaps the folder links the manifest resolves, nested too", function () {
    const result = folderManifestUrl.locals(request(manifest), {
      logo: "/img/a.png",
      site: { images: ["/img/a.png", "text"] },
      title: "hello.world",
    });

    expect(result).toEqual({
      logo: cdnUrl,
      site: { images: [cdnUrl, "text"] },
      title: "hello.world",
    });
  });

  it("never modifies the locals it is given", function () {
    const locals = { logo: "/img/a.png", site: { logo: "/img/a.png" } };

    folderManifestUrl.locals(request(manifest), locals);

    expect(locals).toEqual({ logo: "/img/a.png", site: { logo: "/img/a.png" } });
  });

  it("leaves a link the manifest doesn't resolve, or resolves to a view", function () {
    const locals = { missing: "/img/missing.png", css: "/style.css" };

    expect(folderManifestUrl.locals(request(manifest), locals)).toBe(locals);
  });

  it("returns the same locals on a preview subdomain or without a manifest", function () {
    const locals = { logo: "/img/a.png" };
    const preview = request(manifest);
    preview.preview = true;

    expect(folderManifestUrl.locals(preview, locals)).toBe(locals);
    expect(folderManifestUrl.locals(request({}), locals)).toBe(locals);
    expect(folderManifestUrl.locals({}, locals)).toBe(locals);
    expect(folderManifestUrl.locals(request(manifest), undefined)).toBe(undefined);
  });
});
