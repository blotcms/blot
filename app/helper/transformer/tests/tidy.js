describe("transformer/download/tidy", function () {
  var tidy = require("../download/tidy");

  describe("expire", function () {
    it("turns max-age into an absolute expiry", function () {
      var before = Date.now();
      var got = tidy.expire("public, max-age=3600, immutable");

      expect(got).toEqual(jasmine.any(Number));
      expect(got).toBeGreaterThan(before + 3599 * 1000);
      expect(got).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    });

    it("returns null when there is no max-age", function () {
      expect(tidy.expire("public")).toBe(null);
      expect(tidy.expire("")).toBe(null);
      expect(tidy.expire(null)).toBe(null);
    });

    it("ignores max-age when no-cache or no-store is present", function () {
      expect(tidy.expire("no-cache, max-age=3600")).toBe(null);
      expect(tidy.expire("max-age=3600, no-store")).toBe(null);
    });

    it("does not treat must-revalidate as no-cache", function () {
      expect(tidy.expire("max-age=3600, must-revalidate")).toEqual(
        jasmine.any(Number)
      );
    });

    it("charges the response Age against max-age", function () {
      var now = Date.now();
      var got = tidy.expire("max-age=3600", "3500");

      // ~100s of life left, not a fresh hour
      expect(got).toBeGreaterThan(now);
      expect(got).toBeLessThan(now + 200 * 1000);
    });

    it("returns null once Age has consumed max-age", function () {
      expect(tidy.expire("max-age=100", "500")).toBe(null);
      expect(tidy.expire("max-age=0")).toBe(null);
    });

    it("tolerates a missing or junk Age", function () {
      expect(tidy.expire("max-age=3600", undefined)).toEqual(jasmine.any(Number));
      expect(tidy.expire("max-age=3600", "not-a-number")).toEqual(
        jasmine.any(Number)
      );
    });
  });
});
