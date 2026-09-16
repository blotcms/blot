const isValidSharingLink = require("../util/isValidSharingLink");

describe("isValidSharingLink", function () {
  it("accepts a sharing link without a hash fragment", function () {
    expect(
      isValidSharingLink(
        "https://www.icloud.com/iclouddrive/0aco4snpFDJ8vvYrs319KjEXg"
      )
    ).toBe(true);
  });

  it("accepts a sharing link with a hash fragment", function () {
    expect(
      isValidSharingLink(
        "https://www.icloud.com/iclouddrive/0aco4snpFDJ8vvYrs319KjXg#XYZ"
      )
    ).toBe(true);
  });

  it("rejects an empty or missing link", function () {
    expect(isValidSharingLink("")).toBe(false);
    expect(isValidSharingLink(undefined)).toBe(false);
  });

  it("rejects a non-iCloud Drive URL", function () {
    expect(isValidSharingLink("https://www.icloud.com/photos/abc")).toBe(false);
    expect(isValidSharingLink("https://example.com/iclouddrive/abc")).toBe(
      false
    );
  });
});
