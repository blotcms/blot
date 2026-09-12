describe("similarity", function () {
  const similarity = require("helper/similarity");

  it("returns 1.0 for identical strings", function () {
    expect(similarity("hello", "hello")).toBe(1.0);
    expect(similarity("test", "test")).toBe(1.0);
  });

  it("returns 1.0 for two empty strings", function () {
    expect(similarity("", "")).toBe(1.0);
  });

  it("returns 0 for completely different strings of same length", function () {
    expect(similarity("abc", "xyz")).toBe(0);
  });

  it("returns a value between 0 and 1 for partially similar strings", function () {
    const result = similarity("hello", "hallo");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("is case insensitive", function () {
    expect(similarity("Hello", "hello")).toBe(1.0);
    expect(similarity("HELLO", "hello")).toBe(1.0);
  });

  it("handles strings of different lengths", function () {
    const result = similarity("hello", "hello world");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("returns consistent results regardless of argument order", function () {
    expect(similarity("hello", "world")).toBe(similarity("world", "hello"));
    expect(similarity("abc", "abcd")).toBe(similarity("abcd", "abc"));
  });

  it("calculates higher similarity for more similar strings", function () {
    const similar = similarity("kitten", "sitten");
    const different = similarity("kitten", "puppy");
    expect(similar).toBeGreaterThan(different);
  });

  it("handles single character strings", function () {
    expect(similarity("a", "a")).toBe(1.0);
    expect(similarity("a", "b")).toBe(0);
  });

  it("handles special characters", function () {
    expect(similarity("hello!", "hello!")).toBe(1.0);
    expect(similarity("hello!", "hello?")).toBeGreaterThan(0.8);
  });

  it("handles unicode characters", function () {
    expect(similarity("café", "café")).toBe(1.0);
    expect(similarity("café", "cafe")).toBeGreaterThan(0.5);
  });

  it("handles whitespace differences", function () {
    const result = similarity("hello world", "helloworld");
    expect(result).toBeGreaterThan(0.8);
  });
});
