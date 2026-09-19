describe("unwrapFolderLink", function () {
  const unwrapFolderLink = require("../unwrapFolderLink");
  const BLOT_CDN_TOKEN = require("../cdnToken");
  const blogID = "blog_abc123";

  it("recovers the original path from a baked link", function () {
    expect(
      unwrapFolderLink(
        `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/photos/a.jpg`,
        blogID
      )
    ).toEqual("/photos/a.jpg");
  });

  it("preserves query strings and fragments", function () {
    expect(
      unwrapFolderLink(
        `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/a.svg?x=1#home`,
        blogID
      )
    ).toEqual("/a.svg?x=1#home");
  });

  it("returns null for other blogs, plain paths, and missing blogID", function () {
    const baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/a.jpg`;

    expect(unwrapFolderLink(baked, "blog_other")).toBeNull();
    expect(unwrapFolderLink("/a.jpg", blogID)).toBeNull();
    expect(unwrapFolderLink(baked)).toBeNull();
    expect(
      unwrapFolderLink(`${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}x/a.jpg`, blogID)
    ).toBeNull();
  });
});
