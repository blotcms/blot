describe("helper/transformer/ownHost", function () {
  var ownHost = require("../ownHost");
  var config = require("config");

  describe("hostnames", function () {
    it("includes the custom domain, stripped of a leading www.", function () {
      expect(ownHost.hostnames({ domain: "www.example.com" })).toEqual([
        "example.com"
      ]);
    });

    it("includes the handle's blot.im subdomain", function () {
      expect(ownHost.hostnames({ handle: "foo" })).toEqual([
        "foo." + config.host
      ]);
    });

    it("includes both the domain and the handle when both are given", function () {
      expect(
        ownHost.hostnames({ domain: "example.com", handle: "foo" })
      ).toEqual(["example.com", "foo." + config.host]);
    });

    it("returns an empty list when given nothing", function () {
      expect(ownHost.hostnames({})).toEqual([]);
      expect(ownHost.hostnames()).toEqual([]);
    });
  });

  describe("resolve", function () {
    var ownHostnames = ownHost.hostnames({
      domain: "example.com",
      handle: "foo"
    });

    it("resolves a URL on the custom domain to a local path", function () {
      expect(
        ownHost.resolve("https://example.com/images/cat.jpg", ownHostnames)
      ).toEqual("/images/cat.jpg");
    });

    it("resolves a protocol-relative URL", function () {
      expect(
        ownHost.resolve("//example.com/images/cat.jpg", ownHostnames)
      ).toEqual("/images/cat.jpg");
    });

    it("returns null for a URL with a non-default port", function () {
      expect(
        ownHost.resolve("https://example.com:8443/cat.jpg", ownHostnames)
      ).toBe(null);
    });

    it("allows an explicit default port", function () {
      expect(
        ownHost.resolve("https://example.com:443/cat.jpg", ownHostnames)
      ).toEqual("/cat.jpg");
      expect(
        ownHost.resolve("http://example.com:80/cat.jpg", ownHostnames)
      ).toEqual("/cat.jpg");
    });

    it("returns null for a path app/blog/routes/assets.js serves globally, even if the blog folder happens to have a file there too", function () {
      expect(
        ownHost.resolve("https://example.com/icons/search.svg", ownHostnames)
      ).toBe(null);
      expect(
        ownHost.resolve("https://example.com/fonts/foo.woff2", ownHostnames)
      ).toBe(null);
      expect(
        ownHost.resolve("https://example.com/katex/foo.css", ownHostnames)
      ).toBe(null);
      expect(
        ownHost.resolve("https://example.com/plugins/foo.js", ownHostnames)
      ).toBe(null);
    });

    it("matches reserved global asset prefixes case-insensitively", function () {
      expect(
        ownHost.resolve("https://example.com/ICONS/search.svg", ownHostnames)
      ).toBe(null);
      expect(
        ownHost.resolve("https://example.com/Fonts/foo.woff2", ownHostnames)
      ).toBe(null);
    });

    it("resolves a URL on the handle's blot.im subdomain to a local path", function () {
      expect(
        ownHost.resolve(
          "https://foo." + config.host + "/images/cat.jpg",
          ownHostnames
        )
      ).toEqual("/images/cat.jpg");
    });

    it("treats the www and bare forms of a domain as equivalent", function () {
      expect(
        ownHost.resolve("https://www.example.com/cat.jpg", ownHostnames)
      ).toEqual("/cat.jpg");
    });

    it("strips the query string and hash", function () {
      expect(
        ownHost.resolve(
          "https://example.com/cat.jpg?static=1#top",
          ownHostnames
        )
      ).toEqual("/cat.jpg");
    });

    it("returns null for a URL on a different domain", function () {
      expect(
        ownHost.resolve("https://not-this-blog.com/cat.jpg", ownHostnames)
      ).toBe(null);
    });

    it("returns null for a relative path", function () {
      expect(ownHost.resolve("/cat.jpg", ownHostnames)).toBe(null);
    });

    it("returns null when there are no own hostnames configured", function () {
      expect(ownHost.resolve("https://example.com/cat.jpg", [])).toBe(null);
    });
  });
});
