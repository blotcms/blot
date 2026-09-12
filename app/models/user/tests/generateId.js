var generateId = require("../generateId");

describe("user generateId", function () {
  it("generates a string", function () {
    var id = generateId();
    expect(typeof id).toEqual("string");
  });

  it("starts with user_ prefix", function () {
    var id = generateId();
    expect(id.startsWith("user_")).toBe(true);
  });

  it("has total length of 16 characters", function () {
    var id = generateId();
    expect(id.length).toBe(16);
  });

  it("has 11 characters after prefix", function () {
    var id = generateId();
    var suffix = id.slice(5);
    expect(suffix.length).toBe(11);
  });

  it("uses only alphanumeric characters without ambiguous ones", function () {
    var id = generateId();
    var suffix = id.slice(5);
    var validChars = "1234567890ABCDEFGHJKMNPRSTUVWXYZ";
    for (var i = 0; i < suffix.length; i++) {
      expect(validChars.includes(suffix[i])).toBe(true);
    }
  });

  it("does not contain visually ambiguous characters", function () {
    var ambiguousChars = ["O", "I", "L", "Q"];
    for (var i = 0; i < 100; i++) {
      var id = generateId();
      for (var j = 0; j < ambiguousChars.length; j++) {
        expect(id.includes(ambiguousChars[j])).toBe(false);
      }
    }
  });

  it("generates unique IDs", function () {
    var ids = new Set();
    for (var i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });

  it("uses uppercase letters only", function () {
    for (var i = 0; i < 100; i++) {
      var id = generateId();
      var suffix = id.slice(5);
      expect(suffix).toEqual(suffix.toUpperCase());
    }
  });
});
