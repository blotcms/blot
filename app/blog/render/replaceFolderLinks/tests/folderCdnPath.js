const { folderCdnPath, encodeFolderPath } = require("../shared");

describe("folderCdnPath", function () {
  it("is the bucket key with the version inserted", function () {
    expect(folderCdnPath("blog_abc", "1a2b3c4d", "/photos/my pic.jpg")).toBe(
      "/blog_abc/folder/v-1a2b3c4d/photos/my%20pic.jpg"
    );
  });

  it("spells the path in NFC, as storage keys the object", function () {
    const nfd = "/café.jpg";
    const nfc = "/café.jpg";

    expect(folderCdnPath("blog_abc", "pending", nfd)).toBe(
      "/blog_abc/folder/v-pending" + encodeFolderPath(nfc)
    );
  });
});
