describe("titleFromSlug", function () {
  const titleFromSlug = require("helper/titleFromSlug");

  it("converts hyphenated slug to title", function () {
    expect(titleFromSlug("hello-world")).toBe("Hello world");
  });

  it("capitalizes the first letter", function () {
    expect(titleFromSlug("hello")).toBe("Hello");
  });

  it("replaces all hyphens with spaces", function () {
    expect(titleFromSlug("this-is-a-test")).toBe("This is a test");
  });

  it("handles single word slug", function () {
    expect(titleFromSlug("test")).toBe("Test");
  });

  it("handles slug with numbers", function () {
    expect(titleFromSlug("hello-123-world")).toBe("Hello 123 world");
  });

  it("preserves case of subsequent words", function () {
    expect(titleFromSlug("hello-WORLD")).toBe("Hello WORLD");
  });

  it("handles multiple consecutive hyphens", function () {
    expect(titleFromSlug("hello--world")).toBe("Hello  world");
  });

  it("handles slug starting with number", function () {
    expect(titleFromSlug("123-test")).toBe("123 test");
  });

  it("handles slug ending with hyphen", function () {
    expect(titleFromSlug("test-")).toBe("Test ");
  });

  it("handles slug starting with hyphen", function () {
    expect(titleFromSlug("-test")).toBe(" test");
  });

  it("handles slug with special characters", function () {
    expect(titleFromSlug("hello-world!")).toBe("Hello world!");
  });
});
