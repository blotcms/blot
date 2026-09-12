describe("type", function () {
  const type = require("helper/type");

  describe("type detection", function () {
    it("detects undefined", function () {
      expect(type(undefined)).toBe("undefined");
    });

    it("detects null", function () {
      expect(type(null)).toBe("null");
    });

    it("detects numbers", function () {
      expect(type(42)).toBe("number");
      expect(type(3.14)).toBe("number");
      expect(type(0)).toBe("number");
      expect(type(-1)).toBe("number");
      expect(type(NaN)).toBe("number");
      expect(type(Infinity)).toBe("number");
    });

    it("detects booleans", function () {
      expect(type(true)).toBe("boolean");
      expect(type(false)).toBe("boolean");
    });

    it("detects strings", function () {
      expect(type("")).toBe("string");
      expect(type("hello")).toBe("string");
    });

    it("detects functions", function () {
      expect(type(function () {})).toBe("function");
      expect(type(() => {})).toBe("function");
    });

    it("detects async functions", function () {
      expect(type(async function () {})).toBe("function");
      expect(type(async () => {})).toBe("function");
    });

    it("detects regular expressions", function () {
      expect(type(/abc/)).toBe("regexp");
      expect(type(new RegExp("abc"))).toBe("regexp");
    });

    it("detects arrays", function () {
      expect(type([])).toBe("array");
      expect(type([1, 2, 3])).toBe("array");
      expect(type(new Array())).toBe("array");
    });

    it("detects dates", function () {
      expect(type(new Date())).toBe("date");
    });

    it("detects errors", function () {
      expect(type(new Error())).toBe("error");
      expect(type(new TypeError())).toBe("error");
    });

    it("detects objects", function () {
      expect(type({})).toBe("object");
      expect(type({ a: 1 })).toBe("object");
    });
  });

  describe("type checking with is parameter", function () {
    it("returns true when type matches", function () {
      expect(type(42, "number")).toBe(true);
      expect(type("hello", "string")).toBe(true);
      expect(type([], "array")).toBe(true);
      expect(type({}, "object")).toBe(true);
      expect(type(null, "null")).toBe(true);
      expect(type(undefined, "undefined")).toBe(true);
    });

    it("returns false when type does not match", function () {
      expect(type(42, "string")).toBe(false);
      expect(type("hello", "number")).toBe(false);
      expect(type([], "object")).toBe(false);
      expect(type({}, "array")).toBe(false);
    });
  });
});
