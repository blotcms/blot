describe("cdn", function () {
  var cdn = require("blog/render/retrieve/cdn");
  var mustache = require("mustache");
  var config = require("config");
  var generateCdnUrl = require("models/template/util/generateCdnUrl");

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

  it("returns CDN URL for normal requests with SITE template", function (done) {
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toContain(config.cdn.origin);
      expect(result).toContain("/template/");
      // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
      expect(result).toMatch(new RegExp(`/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`));
      done();
    });
  });

  it("returns CDN URL for normal requests with custom template", function (done) {
    this.request.template.id = this.blog.id + ":custom";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toContain(config.cdn.origin);
      expect(result).toContain("/template/");
      // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
      expect(result).toMatch(new RegExp(`/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`));
      done();
    });
  });

  it("skips CDN URL for preview subdomains on custom templates", function (done) {
    this.request.preview = true;
    this.request.template.id = this.blog.id + ":custom";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe("/style.css");
      expect(result).not.toContain(config.cdn.origin);
      done();
    });
  });

  it("does not use CDN URL for preview subdomains on SITE templates", function (done) {
    this.request.preview = true;
    this.request.template.id = "SITE:blog";
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe('/style.css')
      done();
    });
  });

  it("returns original path when view not in manifest", function (done) {
    var result;
    var template = "{{#cdn}}/missing.css{{/cdn}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe("/missing.css");
      done();
    });
  });

  it("returns CDN origin for interpolation", function (done) {
    var result;
    var template = "{{{cdn}}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe(config.cdn.origin);
      done();
    });
  });

  it("handles missing template gracefully", function (done) {
    this.request.template = null;
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe("/style.css");
      done();
    });
  });

  it("handles missing manifest gracefully", function (done) {
    this.request.template = {
      id: "SITE:blog",
      cdn: null,
    };
    var result;
    var template = "{{#cdn}}/style.css{{/cdn}}";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toBe("/style.css");
      done();
    });
  });

  it("works without leading slash", function (done) {
    this.request.template.cdn["style.css"] = "abc123def456ghi789jkl012mno345pq";
    var result;
    var template = "{{#cdn}}style.css{{/cdn}}";
    var hash = "abc123def456ghi789jkl012mno345pq";

    cdn(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { cdn: lambda });
      expect(result).toContain(config.cdn.origin);
      expect(result).toContain("/template/");
      // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
      expect(result).toMatch(new RegExp(`/template/${hash.substring(0, 2)}/${hash.substring(2, 4)}/${hash.substring(4)}/style\\.css`));
      done();
    });
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

    it("returns a versioned folder URL using the file's real path", function (done) {
      var blogID = this.blog.id;

      cdn(this.request, {}, function (err, lambda) {
        expect(mustache.render("{{#cdn}}/images/a.png{{/cdn}}", { cdn: lambda })).toBe(
          "%%BLOT_CDN%%/folder/v-deadbeef/" + blogID + "/images/A.png"
        );
        done();
      });
    });

    it("keeps the query string and hash of the link", function (done) {
      var blogID = this.blog.id;

      cdn(this.request, {}, function (err, lambda) {
        expect(
          mustache.render("{{#cdn}}/images/a.png?v=2#top{{/cdn}}", { cdn: lambda })
        ).toBe("%%BLOT_CDN%%/folder/v-deadbeef/" + blogID + "/images/A.png?v=2#top");
        done();
      });
    });

    it("returns an unversioned URL for a reserved global path", function (done) {
      cdn(this.request, {}, function (err, lambda) {
        expect(mustache.render("{{#cdn}}/icons/search.svg{{/cdn}}", { cdn: lambda })).toBe(
          "%%BLOT_CDN%%/icons/search.svg"
        );
        done();
      });
    });

    it("still returns view URLs", function (done) {
      cdn(this.request, {}, function (err, lambda) {
        expect(mustache.render("{{#cdn}}/style.css{{/cdn}}", { cdn: lambda })).toContain(
          "/template/"
        );
        done();
      });
    });

    it("leaves a folder file that isn't in the manifest as written", function (done) {
      cdn(this.request, {}, function (err, lambda) {
        expect(mustache.render("{{#cdn}}/images/b.png{{/cdn}}", { cdn: lambda })).toBe(
          "/images/b.png"
        );
        done();
      });
    });

    it("skips folder URLs for preview subdomains", function (done) {
      this.request.preview = true;

      cdn(this.request, {}, function (err, lambda) {
        expect(mustache.render("{{#cdn}}/images/a.png{{/cdn}}", { cdn: lambda })).toBe(
          "/images/a.png"
        );
        done();
      });
    });
  });
});

