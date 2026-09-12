describe("alphanum", function () {
  const alphanum = require("helper/alphanum");

  describe("sort", function () {
    it("sorts an empty array", function () {
      expect(alphanum([])).toEqual([]);
    });

    it("returns array unchanged if less than 2 elements", function () {
      expect(alphanum(["a"])).toEqual(["a"]);
    });

    it("sorts strings alphabetically", function () {
      expect(alphanum(["b", "a", "c"])).toEqual(["a", "b", "c"]);
    });

    it("sorts numbers naturally (not lexicographically)", function () {
      expect(alphanum(["1", "10", "2", "20", "3"])).toEqual([
        "1",
        "2",
        "3",
        "10",
        "20",
      ]);
    });

    it("sorts mixed strings and numbers naturally", function () {
      expect(alphanum(["file1", "file10", "file2", "file20"])).toEqual([
        "file1",
        "file2",
        "file10",
        "file20",
      ]);
    });

    it("handles leading zeros", function () {
      expect(alphanum(["file001", "file01", "file1"])).toEqual([
        "file001",
        "file01",
        "file1",
      ]);
    });

    it("sorts case-insensitively with option", function () {
      expect(alphanum(["B", "a", "C"], { insensitive: true })).toEqual([
        "a",
        "B",
        "C",
      ]);
    });

    it("sorts with sign option for negative numbers", function () {
      expect(alphanum(["-1", "2", "-3", "0"], { sign: true })).toEqual([
        "-3",
        "-1",
        "0",
        "2",
      ]);
    });

    it("sorts objects by property", function () {
      const arr = [{ name: "file10" }, { name: "file2" }, { name: "file1" }];
      expect(alphanum(arr, { property: "name" })).toEqual([
        { name: "file1" },
        { name: "file2" },
        { name: "file10" },
      ]);
    });

    it("handles whitespace correctly", function () {
      expect(alphanum(["  a", "b", " c"])).toEqual(["  a", "b", " c"]);
    });

    it("handles empty strings", function () {
      expect(alphanum(["b", "", "a"])).toEqual(["", "a", "b"]);
    });

    it("handles strings with only numbers", function () {
      expect(alphanum(["100", "20", "3"])).toEqual(["3", "20", "100"]);
    });
  });

  describe("compare", function () {
    it("returns 0 for equal strings", function () {
      expect(alphanum.compare("abc", "abc")).toBe(0);
    });

    it("returns negative for a < b", function () {
      expect(alphanum.compare("a", "b")).toBeLessThan(0);
    });

    it("returns positive for a > b", function () {
      expect(alphanum.compare("b", "a")).toBeGreaterThan(0);
    });

    it("compares numbers naturally", function () {
      expect(alphanum.compare("file2", "file10")).toBeLessThan(0);
      expect(alphanum.compare("file10", "file2")).toBeGreaterThan(0);
    });

    it("handles case insensitive comparison", function () {
      expect(alphanum.compare("A", "b", { insensitive: true })).toBeLessThan(0);
    });

    it("handles signed numbers with sign option", function () {
      expect(alphanum.compare("-5", "3", { sign: true })).toBeLessThan(0);
      expect(alphanum.compare("3", "-5", { sign: true })).toBeGreaterThan(0);
    });

    it("handles empty strings", function () {
      expect(alphanum.compare("", "")).toBe(0);
      expect(alphanum.compare("", "a")).toBeLessThan(0);
      expect(alphanum.compare("a", "")).toBeGreaterThan(0);
    });
  });
});
