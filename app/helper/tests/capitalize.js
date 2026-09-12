describe("capitalize", function () {
  const capitalize = require("helper/capitalize");

  it("capitalizes the first letter of a string", function () {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("preserves the rest of the string", function () {
    expect(capitalize("hello world")).toBe("Hello world");
  });

  it("handles already capitalized strings", function () {
    expect(capitalize("Hello")).toBe("Hello");
  });

  it("handles all uppercase strings", function () {
    expect(capitalize("HELLO")).toBe("HELLO");
  });

  it("handles single character string", function () {
    expect(capitalize("a")).toBe("A");
    expect(capitalize("A")).toBe("A");
  });

  it("handles string starting with number", function () {
    expect(capitalize("123abc")).toBe("123abc");
  });

  it("handles string starting with special character", function () {
    expect(capitalize("!hello")).toBe("!hello");
  });

  it("handles mixed case string", function () {
    expect(capitalize("hELLO")).toBe("HELLO");
  });

  it("handles string with spaces", function () {
    expect(capitalize(" hello")).toBe(" hello");
  });

  it("handles unicode characters", function () {
    expect(capitalize("über")).toBe("Über");
  });

  it("handles accented lowercase letters", function () {
    expect(capitalize("élan")).toBe("Élan");
  });
});
