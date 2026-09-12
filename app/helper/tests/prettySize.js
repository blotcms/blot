describe("prettySize", function () {
  const prettySize = require("helper/prettySize");

  it("returns '0 Bytes' for 0 kilobytes", function () {
    expect(prettySize(0)).toBe("0 Bytes");
  });

  it("converts small kilobytes to Bytes", function () {
    expect(prettySize(0.5)).toBe("500 Bytes");
  });

  it("converts kilobytes to KB", function () {
    expect(prettySize(1)).toBe("1000 Bytes");
    expect(prettySize(2)).toBe("1.95 KB");
  });

  it("converts to MB for larger values", function () {
    expect(prettySize(1024)).toBe("1000 KB");
    expect(prettySize(1048.576)).toBe("1 MB");
  });

  it("converts to GB for larger values", function () {
    expect(prettySize(1073741.824)).toBe("1 GB");
  });

  it("handles custom decimal places", function () {
    expect(prettySize(1.5, 0)).toBe("1 KB");
    expect(prettySize(1.5, 1)).toBe("1.5 KB");
    expect(prettySize(1.5, 3)).toBe("1.465 KB");
  });

  it("uses 2 decimal places by default", function () {
    expect(prettySize(1.555)).toBe("1.52 KB");
  });

  it("handles negative decimal places as 0", function () {
    expect(prettySize(1.5, -1)).toBe("1 KB");
  });

  it("handles very large values", function () {
    const result = prettySize(1e12);
    expect(result).toContain("TB");
  });

  it("handles fractional kilobytes", function () {
    expect(prettySize(0.001)).toBe("1 Bytes");
  });
});
