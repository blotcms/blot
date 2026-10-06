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

  it("leaves the path percent-encoded", function () {
    expect(
      unwrapFolderLink(
        `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/my%20pic.jpg?x=a%20b#c`,
        blogID
      )
    ).toEqual("/my%20pic.jpg?x=a%20b#c");
  });

  it("round-trips paths through encodeFolderPath and decodeFolderPath", function () {
    const { encodeFolderPath, decodeFolderPath } = require("../shared");

    [
      "/my pic.jpg",
      "/100% luck.jpg",
      "/hero#1.jpg",
      "/a dir/#1 ?.jpg",
      "/it's (1)!*.jpg",
      "/café, 2x.jpg",
      "/already%20encoded.jpg",
    ].forEach((path) => {
      const baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}${encodeFolderPath(path)}`;
      expect(baked.slice(BLOT_CDN_TOKEN.length)).not.toMatch(/[\s,#?'"()]/);

      const unwrapped = unwrapFolderLink(baked + "?x=1#top", blogID);
      const [pathPart, suffix] = unwrapped.split(/(?=[?#])/);
      expect(decodeFolderPath(pathPart)).toEqual(path);
      expect(suffix).toEqual("?x=1");
    });
  });

  it("decodes paths baked before encoding to themselves", function () {
    const { decodeFolderPath } = require("../shared");

    expect(decodeFolderPath("/my pic.jpg")).toEqual("/my pic.jpg");
    expect(decodeFolderPath("/100% luck.jpg")).toEqual("/100% luck.jpg");
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
