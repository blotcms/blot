describe("firstSentence", function () {
  const firstSentence = require("helper/firstSentence");

  it("returns empty string for empty input", function () {
    expect(firstSentence("")).toBe("");
    expect(firstSentence("   ")).toBe("");
  });

  it("returns empty string for null or undefined", function () {
    expect(firstSentence(null)).toBe("");
    expect(firstSentence(undefined)).toBe("");
  });

  it("extracts first sentence ending with period", function () {
    expect(firstSentence("Hello world. This is a test.")).toBe("Hello world.");
  });

  it("extracts first sentence ending with exclamation mark", function () {
    expect(firstSentence("Hello world! This is a test.")).toBe("Hello world!");
  });

  it("extracts first sentence ending with question mark", function () {
    expect(firstSentence("Hello world? This is a test.")).toBe("Hello world?");
  });

  it("returns entire string if no sentence ending found", function () {
    expect(firstSentence("Hello world")).toBe("Hello world");
  });

  it("only takes first line for multi-line input", function () {
    expect(firstSentence("First line.\nSecond line.")).toBe("First line.");
  });

  it("handles first line without sentence ending", function () {
    expect(firstSentence("First line\nSecond line.")).toBe("First line");
  });

  it("trims whitespace", function () {
    expect(firstSentence("  Hello world.  ")).toBe("Hello world.");
  });

  it("handles multiple sentences on first line", function () {
    expect(firstSentence("First. Second. Third.")).toBe("First.");
  });

  it("handles ellipsis", function () {
    const result = firstSentence("Hello... world. More text.");
    expect(result).toBe("Hello...");
  });

  it("handles very long strings by truncating", function () {
    const longString = "a".repeat(2000);
    const result = firstSentence(longString);
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("handles strings with only whitespace characters", function () {
    expect(firstSentence("\n\n\n")).toBe("");
  });

  it("handles strings with special characters", function () {
    expect(firstSentence("Hello @world! More text.")).toBe("Hello @world!");
  });
});
