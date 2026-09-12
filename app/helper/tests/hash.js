describe("hash", function () {
  const hash = require("helper/hash");

  it("returns a 32 character hex string", function () {
    const result = hash("test");
    expect(result.length).toBe(32);
    expect(result).toMatch(/^[a-f0-9]{32}$/);
  });

  it("returns consistent results for same input", function () {
    expect(hash("hello")).toBe(hash("hello"));
    expect(hash("world")).toBe(hash("world"));
  });

  it("returns different results for different inputs", function () {
    expect(hash("hello")).not.toBe(hash("world"));
    expect(hash("test1")).not.toBe(hash("test2"));
  });

  it("handles empty string", function () {
    const result = hash("");
    expect(result.length).toBe(32);
    expect(result).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("handles special characters", function () {
    const result = hash("!@#$%^&*()");
    expect(result.length).toBe(32);
  });

  it("handles unicode characters", function () {
    const result = hash("日本語");
    expect(result.length).toBe(32);
  });

  it("handles whitespace", function () {
    expect(hash(" ")).not.toBe(hash(""));
    expect(hash("hello world")).not.toBe(hash("helloworld"));
  });

  it("handles long strings", function () {
    const longString = "a".repeat(10000);
    const result = hash(longString);
    expect(result.length).toBe(32);
  });

  it("produces known MD5 hashes", function () {
    expect(hash("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6"
    );
    expect(hash("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("is case sensitive", function () {
    expect(hash("Hello")).not.toBe(hash("hello"));
    expect(hash("HELLO")).not.toBe(hash("hello"));
  });
});
