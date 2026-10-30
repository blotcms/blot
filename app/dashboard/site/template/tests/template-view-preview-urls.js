describe("template view preview URLs", function () {
  const { previewUrls } = require("../load/template-view");
  const origin = "https://preview-of-my-template-on-example.blot.im";

  it("builds preview, output and json URLs from a view's url", function () {
    expect(previewUrls({ url: "/archive" }, origin)).toEqual({
      previewUrl: origin + "/archive",
      outputUrl: origin + "/archive?output=true",
      jsonUrl: origin + "/archive?json=true",
    });
  });

  it("appends to an existing query string", function () {
    const urls = previewUrls({ url: "/search?q=a" }, origin);

    expect(urls.outputUrl).toEqual(origin + "/search?q=a&output=true");
    expect(urls.jsonUrl).toEqual(origin + "/search?q=a&json=true");
  });

  it("skips patterns that cannot be visited as-is", function () {
    const urls = previewUrls(
      { urlPatterns: ["/page/:number", "/tagged/*", "/(a|b)"], url: "/archive" },
      origin
    );

    expect(urls.previewUrl).toEqual(origin + "/archive");
  });

  it("skips protocol-relative and relative paths", function () {
    expect(previewUrls({ url: ["//evil.example/x", "relative"] }, origin)).toEqual({});
  });

  it("returns nothing when no url is visitable", function () {
    expect(previewUrls({ url: "/page/:number" }, origin)).toEqual({});
    expect(previewUrls({}, origin)).toEqual({});
  });
});
