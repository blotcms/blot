describe("sync/update/drafts", function () {
  var drafts = require("../update/drafts");

  it("isDraft and isPreview return promises without a callback", async function () {
    expect(await drafts.isDraft("blog-id", "/[draft] hello.txt")).toBe(true);
    expect(await drafts.isDraft("blog-id", "/hello.txt")).toBe(false);
    expect(await drafts.isPreview("blog-id", "/hello.txt")).toBe(false);
    expect(await drafts.isPreview("blog-id", "/hello.preview.html")).toBe(true);
  });

  it("isDraft throws when passed a callback", function () {
    expect(function () {
      drafts.isDraft("blog-id", "/[draft] hello.txt", function () {});
    }).toThrowError(/no longer takes a callback/);
  });
});
