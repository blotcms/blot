describe("cdn", function () {
  var cdn = require("blog/render/retrieve/cdn");
  var mustache = require("mustache");
  var config = require("config");

  global.test.blog();

  beforeEach(function () {
    this.request = {
      protocol: "http",
      get: function () {
        return "example.com";
      },
      preview: false,
      template: {
        id: "SITE:blog",
        cdn: {
          "style.css": "abc123def456ghi789jkl012mno345pq",
        },
      },
    };
  });

  it("returns CDN URL for normal requests with SITE template", async function () {
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toContain(config.cdn.origin);
    expect(result).toContain("/template/");
    // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
    expect(result).toMatch(
      new RegExp(
        `/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`
      )
    );
  });

  it("returns CDN URL for normal requests with custom template", async function () {
    this.request.template.id = this.blog.id + ":custom";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toContain(config.cdn.origin);
    expect(result).toContain("/template/");
    // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
    expect(result).toMatch(
      new RegExp(
        `/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`
      )
    );
  });

  it("skips CDN URL for preview subdomains on custom templates", async function () {
    this.request.preview = true;
    this.request.template.id = this.blog.id + ":custom";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe("/style.css");
    expect(result).not.toContain(config.cdn.origin);
  });

  it("does not use CDN URL for preview subdomains on SITE templates", async function () {
    this.request.preview = true;
    this.request.template.id = "SITE:blog";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe("/style.css");
  });

  it("returns original path when view not in manifest", async function () {
    var result;
    var template = "{{#cdn}}/missing.css{{/cdn}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe("/missing.css");
  });

  it("returns CDN origin for interpolation", async function () {
    var result;
    var template = "{{{cdn}}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe(config.cdn.origin);
  });

  it("handles missing template gracefully", async function () {
    this.request.template = null;
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe("/style.css");
  });

  it("handles missing manifest gracefully", async function () {
    this.request.template = {
      id: "SITE:blog",
      cdn: null,
    };
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toBe("/style.css");
  });

  it("works without leading slash", async function () {
    this.request.template.cdn["style.css"] = "abc123def456ghi789jkl012mno345pq";
    var result;
    var template = "{{#cdn}}style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    const lambda = await cdn(this.request, {});
    result = mustache.render(template, { cdn: lambda });
    expect(result).toContain(config.cdn.origin);
    expect(result).toContain("/template/");
    // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
    expect(result).toMatch(
      new RegExp(
        `/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`
      )
    );
  });

  describe("folder files", function () {
    beforeEach(function () {
      this.request.blog = { id: this.blog.id };
      this.request.template.id = this.blog.id + ":custom";
      this.request.template.cdn = {
        "images/a.png": { path: "/images/A.png", version: "deadbeef" },
        "images/a.png?v=2#top": { path: "/images/A.png", version: "deadbeef" },
        "icons/search.svg": { path: "/icons/search.svg" },
        "style.css": "abc123def456ghi789jkl012mno345pq",
      };
    });

    it("returns a versioned folder URL using the file's real path", async function () {
      var blogID = this.blog.id;

      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/images/a.png{{/cdn}}", { cdn: lambda })
      ).toBe("%%BLOT_CDN%%/folder/v-deadbeef/" + blogID + "/images/A.png");
    });

    it("keeps the query string and hash of the link", async function () {
      var blogID = this.blog.id;

      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/images/a.png?v=2#top{{/cdn}}", {
          cdn: lambda,
        })
      ).toBe(
        "%%BLOT_CDN%%/folder/v-deadbeef/" + blogID + "/images/A.png?v=2#top"
      );
    });

    it("returns an unversioned URL for a reserved global path", async function () {
      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/icons/search.svg{{/cdn}}", { cdn: lambda })
      ).toBe("%%BLOT_CDN%%/icons/search.svg");
    });

    it("still returns view URLs", async function () {
      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/style.css{{/cdn}}", { cdn: lambda })
      ).toContain("/template/");
    });

    it("leaves a folder file that isn't in the manifest as written", async function () {
      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/images/b.png{{/cdn}}", { cdn: lambda })
      ).toBe("/images/b.png");
    });

    it("leaves a missing rooted path as written, query included", async function () {
      this.request.blog.url = "https://example.blot.im";

      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/images/b.png?v=1{{/cdn}}", { cdn: lambda })
      ).toBe("/images/b.png?v=1");
    });

    it("leaves a missing view name and a protocol-relative link as written", async function () {
      this.request.blog.url = "https://example.blot.im";

      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}missing.css{{/cdn}}", { cdn: lambda })
      ).toBe("missing.css");
      expect(
        mustache.render("{{#cdn}}//other.com/a.png{{/cdn}}", { cdn: lambda })
      ).toBe("//other.com/a.png");
    });

    it("skips folder URLs for preview subdomains", async function () {
      this.request.preview = true;

      const lambda = await cdn(this.request, {});
      expect(
        mustache.render("{{#cdn}}/images/a.png{{/cdn}}", { cdn: lambda })
      ).toBe("/images/a.png");
    });
  });
});
