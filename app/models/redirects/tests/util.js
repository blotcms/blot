describe("redirects.util", function () {
  const { is, map, isRegex, notRegex, matches } = require("../util");

  describe("isRegex / notRegex", function () {
    it("treats a plain path as not a regex", function () {
      expect(isRegex("/apples")).toBe(false);
      expect(notRegex("/apples")).toBe(true);
    });

    it("treats a path with a capture group or $1 as a regex", function () {
      expect(isRegex("/posts/(.*)")).toBeTruthy();
      expect(isRegex("/blog/$1")).toBeTruthy();
    });

    it("treats a path starting with a backslash as a regex", function () {
      expect(isRegex("\\/posts\\/(.*)")).toBeTruthy();
    });
  });

  describe("is", function () {
    it("matches a URL against a simple regex, as in the docs example", function () {
      expect(is("/posts/hello", "/posts/(.*)")).toBe(true);
      expect(is("/other/hello", "/posts/(.*)")).toBe(false);
    });

    it("is case-insensitive, like the built-in RegExp it replaced", function () {
      expect(is("/POSTS/hello", "/posts/(.*)")).toBe(true);
    });

    it("returns false instead of throwing for an invalid pattern", function () {
      expect(is("/anything", "(")).toBe(false);
    });

    it("does not hang on a pattern crafted for catastrophic backtracking", function () {
      // (a+)+$ is a classic ReDoS pattern: a backtracking engine takes
      // exponential time to fail to match a run of "a"s followed by a
      // character that can never satisfy the trailing $. RE2 matches in
      // time linear in the length of the input, so this stays fast
      // regardless of how many "a"s are added.
      var evilInput = "a".repeat(40) + "!";

      var start = Date.now();
      var result = is(evilInput, "(a+)+$");
      var duration = Date.now() - start;

      expect(result).toBe(false);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe("map", function () {
    it("substitutes a capture group, as in the docs example", function () {
      expect(map("/posts/hello", "/posts/(.*)", "/blog/$1")).toEqual(
        "/blog/hello"
      );
    });

    it("returns null instead of throwing for an invalid pattern", function () {
      expect(map("/anything", "(", "/elsewhere")).toEqual(null);
    });

    it("returns null for a pattern RE2 does not support, such as a lookahead", function () {
      expect(map("/posts/hello", "/posts/(?=hello)", "/blog")).toEqual(null);
    });
  });

  describe("matches", function () {
    it("matches an exact 'to' against existing mappings", function () {
      expect(matches("/blog/hello", [{ from: "/blog/hello" }])).toBe(true);
    });

    it("matches a 'to' against an existing regex mapping", function () {
      expect(matches("/blog/hello", [{ from: "/posts/(.*)" }])).toBe(false);
      expect(matches("/posts/hello", [{ from: "/posts/(.*)" }])).toBe(true);
    });

    it("returns false when nothing matches", function () {
      expect(matches("/nothing", [{ from: "/posts/(.*)" }])).toBe(false);
    });
  });
});
