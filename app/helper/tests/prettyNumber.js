describe("prettyNumber", function () {
  const prettyNumber = require("helper/prettyNumber");

  it("formats small numbers without commas", function () {
    expect(prettyNumber(1)).toBe("1");
    expect(prettyNumber(12)).toBe("12");
    expect(prettyNumber(123)).toBe("123");
  });

  it("adds comma for thousands", function () {
    expect(prettyNumber(1000)).toBe("1,000");
    expect(prettyNumber(1234)).toBe("1,234");
  });

  it("adds commas for millions", function () {
    expect(prettyNumber(1000000)).toBe("1,000,000");
    expect(prettyNumber(1234567)).toBe("1,234,567");
  });

  it("adds commas for billions", function () {
    expect(prettyNumber(1000000000)).toBe("1,000,000,000");
  });

  it("handles zero", function () {
    expect(prettyNumber(0)).toBe("0");
  });

  it("handles negative numbers", function () {
    expect(prettyNumber(-1000)).toBe("-1,000");
    expect(prettyNumber(-1234567)).toBe("-1,234,567");
  });

  it("handles decimal numbers", function () {
    expect(prettyNumber(1234.56)).toBe("1,234.56");
    expect(prettyNumber(1000000.99)).toBe("1,000,000.99");
  });

  it("handles numbers just below thousand", function () {
    expect(prettyNumber(999)).toBe("999");
  });

  it("handles large numbers", function () {
    expect(prettyNumber(123456789012)).toBe("123,456,789,012");
  });
});
