describe("deCamelize", function () {
  const deCamelize = require("helper/deCamelize");

  it("converts camelCase to space-separated words", function () {
    expect(deCamelize("helloWorld")).toBe("Hello world");
  });

  it("capitalizes the first letter", function () {
    expect(deCamelize("hello")).toBe("Hello");
  });

  it("handles multiple uppercase letters", function () {
    expect(deCamelize("helloWorldTest")).toBe("Hello world test");
  });

  it("handles string starting with uppercase", function () {
    expect(deCamelize("HelloWorld")).toBe("Hello world");
  });

  it("handles single word", function () {
    expect(deCamelize("hello")).toBe("Hello");
    expect(deCamelize("Hello")).toBe("Hello");
  });

  it("handles empty string", function () {
    expect(deCamelize("")).toBe("");
  });

  it("handles null or undefined", function () {
    expect(deCamelize(null)).toBe("");
    expect(deCamelize(undefined)).toBe("");
  });

  it("handles all uppercase string", function () {
    expect(deCamelize("HELLO")).toBe("H e l l o");
  });

  it("handles string with numbers", function () {
    expect(deCamelize("hello123World")).toBe("Hello123 world");
  });

  it("handles PascalCase", function () {
    expect(deCamelize("PascalCase")).toBe("Pascal case");
  });

  it("handles consecutive uppercase letters", function () {
    expect(deCamelize("helloWORLD")).toBe("Hello w o r l d");
  });

  it("handles single character", function () {
    expect(deCamelize("a")).toBe("A");
    expect(deCamelize("A")).toBe("A");
  });
});
