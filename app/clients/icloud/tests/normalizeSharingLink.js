const normalizeSharingLink = require("../util/normalizeSharingLink");

describe("normalizeSharingLink", function () {
  const link = "https://www.icloud.com/iclouddrive/0d4g02LSSCiTMOsvmxIr94Tjg";

  it("keeps a link that is already valid", function () {
    expect(normalizeSharingLink(link)).toBe(link);
    expect(normalizeSharingLink(link + "#Site")).toBe(link + "#Site");
  });

  it("trims spaces, line breaks and wrapping characters", function () {
    expect(normalizeSharingLink("  " + link + "\n")).toBe(link);
    expect(normalizeSharingLink("<" + link + ">")).toBe(link);
    expect(normalizeSharingLink("“" + link + "”")).toBe(link);
  });

  it("adds a missing scheme and www", function () {
    expect(
      normalizeSharingLink(
        "www.icloud.com/iclouddrive/0d4g02LSSCiTMOsvmxIr94Tjg"
      )
    ).toBe(link);
    expect(
      normalizeSharingLink("icloud.com/iclouddrive/0d4g02LSSCiTMOsvmxIr94Tjg")
    ).toBe(link);
    expect(
      normalizeSharingLink(
        "http://icloud.com/iclouddrive/0d4g02LSSCiTMOsvmxIr94Tjg"
      )
    ).toBe(link);
  });

  it("returns null for anything else", function () {
    expect(normalizeSharingLink("")).toBe(null);
    expect(normalizeSharingLink(undefined)).toBe(null);
    expect(normalizeSharingLink("https://www.icloud.com/photos/abc")).toBe(
      null
    );
    expect(normalizeSharingLink("https://example.com/iclouddrive/abc")).toBe(
      null
    );
    expect(normalizeSharingLink("link@blot.im")).toBe(null);
  });
  it("stays quick on long runs of quote marks", function () {
    const start = Date.now();
    expect(normalizeSharingLink('"'.repeat(100000) + "x")).toBe(null);
    expect(normalizeSharingLink("x" + '"'.repeat(100000))).toBe(null);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
