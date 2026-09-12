describe("falsy", function () {
  const falsy = require("helper/falsy");

  describe("returns true for falsy values", function () {
    it("returns true for undefined", function () {
      expect(falsy(undefined)).toBe(true);
    });

    it("returns true for null", function () {
      expect(falsy(null)).toBe(true);
    });

    it("returns true for false", function () {
      expect(falsy(false)).toBe(true);
    });

    it("returns true for empty string", function () {
      expect(falsy("")).toBe(true);
    });

    it("returns true for 'no'", function () {
      expect(falsy("no")).toBe(true);
      expect(falsy("NO")).toBe(true);
      expect(falsy("No")).toBe(true);
    });

    it("returns true for 'non'", function () {
      expect(falsy("non")).toBe(true);
      expect(falsy("NON")).toBe(true);
    });

    it("returns true for 'not'", function () {
      expect(falsy("not")).toBe(true);
      expect(falsy("NOT")).toBe(true);
    });

    it("returns true for 'false'", function () {
      expect(falsy("false")).toBe(true);
      expect(falsy("FALSE")).toBe(true);
      expect(falsy("False")).toBe(true);
    });

    it("returns true for 'off'", function () {
      expect(falsy("off")).toBe(true);
      expect(falsy("OFF")).toBe(true);
      expect(falsy("Off")).toBe(true);
    });

    it("handles strings with whitespace", function () {
      expect(falsy("  no  ")).toBe(true);
      expect(falsy("  false  ")).toBe(true);
      expect(falsy("  off  ")).toBe(true);
    });
  });

  describe("returns false for truthy values", function () {
    it("returns false for true", function () {
      expect(falsy(true)).toBe(false);
    });

    it("returns false for non-zero numbers", function () {
      expect(falsy(1)).toBe(false);
      expect(falsy(-1)).toBe(false);
      expect(falsy(100)).toBe(false);
    });

    it("returns false for zero", function () {
      expect(falsy(0)).toBe(false);
    });

    it("returns false for non-falsy strings", function () {
      expect(falsy("yes")).toBe(false);
      expect(falsy("true")).toBe(false);
      expect(falsy("on")).toBe(false);
      expect(falsy("hello")).toBe(false);
    });

    it("returns false for objects", function () {
      expect(falsy({})).toBe(false);
      expect(falsy({ a: 1 })).toBe(false);
    });

    it("returns false for arrays", function () {
      expect(falsy([])).toBe(false);
      expect(falsy([1, 2, 3])).toBe(false);
    });
  });
});
