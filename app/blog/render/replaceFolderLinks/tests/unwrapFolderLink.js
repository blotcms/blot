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

  it("decodes the percent-encoded path, but not the query or fragment", function () {
    expect(
      unwrapFolderLink(
        `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/my%20pic.jpg?x=a%20b#c%20d`,
        blogID
      )
    ).toEqual("/my pic.jpg?x=a%20b#c%20d");
  });

  it("round-trips paths encoded with encodeFolderPath", function () {
    const { encodeFolderPath } = require("../shared");

    [
      "/my pic.jpg",
      "/100% luck.jpg",
      "/a dir/#1 ?.jpg",
      "/café, 2x.jpg",
      "/already%20encoded.jpg",
    ].forEach((path) => {
      const baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}${encodeFolderPath(path)}`;
      expect(baked.slice(BLOT_CDN_TOKEN.length)).not.toMatch(/[\s,#?]/);
      expect(unwrapFolderLink(baked, blogID)).toEqual(path);
    });
  });

  it("returns links baked before paths were encoded unchanged", function () {
    expect(
      unwrapFolderLink(`${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/my pic.jpg`, blogID)
    ).toEqual("/my pic.jpg");
    expect(
      unwrapFolderLink(`${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/100% luck.jpg`, blogID)
    ).toEqual("/100% luck.jpg");
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
