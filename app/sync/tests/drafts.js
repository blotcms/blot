describe("sync/update/drafts", function () {
  var drafts = require("../update/drafts");

  it("isDraft and isPreview return promises without a callback", async function () {
    expect(await drafts.isDraft("blog-id", "/[draft] hello.txt")).toBe(true);
    expect(await drafts.isDraft("blog-id", "/hello.txt")).toBe(false);
    expect(await drafts.isPreview("blog-id", "/hello.txt")).toBe(false);
    expect(await drafts.isPreview("blog-id", "/hello.preview.html")).toBe(true);
  });
});
