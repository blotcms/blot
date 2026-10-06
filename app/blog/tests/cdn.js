const config = require("config");

describe("cdn template function", function () {
  require("./util/setup")();

  const { cdnRegex, extractHash, validate } = require('./util/cdn');

  it("renders origin", async function () {
    await this.template({
      "entries.html": `{{{cdn}}}`,
    });

    expect(await this.text("/")).toBe(config.cdn.origin);
  });

  it("works", async function () {
    await this.template({
      "style.css": "body { color: red; }",
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });

    validate(await this.text("/"));
  });

  it("works when you create views in the wrong order", async function () {
    await this.template({
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
      "style.css": "body { color: red; }",
    });

    validate(await this.text("/"));
  });

  it("returns an absolute URL on the blog's host for a missing rooted target", async function () {
    await this.template({
      "entries.html": "{{{blog.url}}}|{{#cdn}}/style.css{{/cdn}}",
    });

    const [blogURL, missing] = (await this.text("/")).split("|");

    expect(blogURL).toMatch(/^https?:\/\//);
    expect(missing).toBe(blogURL + "/style.css");
  });

  it("returns the contents of the block as-is for a missing target without a leading slash", async function () {
    await this.template({
      "entries.html": "{{#cdn}}style.css{{/cdn}}|{{#cdn}}missing.css{{/cdn}}",
    });

    expect(await this.text("/")).toBe("style.css|missing.css");
  });

  it("gracefully handles a single missing view (absolute URL on the blog's host)", async function () {
    await this.template({
      "entries.html":
        "{{{blog.url}}}|{{#cdn}}/missing.css{{/cdn}}|{{#cdn}}/style.css{{/cdn}}",
      "style.css": "body{color:#000}",
    });

    const [blogURL, invalidURL, validURL] = (await this.text("/")).split("|");

    expect(invalidURL).toBe(blogURL + "/missing.css");
    validate(validURL);
  });

  it("works when you update an existing view", async function () {
    const template = {
      "style.css": "body { color: red; }",
      "entries.html": "{{{cdn}}}",
    };

    await this.template(template);

    expect(await this.text("/")).toBe(config.cdn.origin);

    await this.template({
      ...template,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });

    validate(await this.text("/"));
  });

  it("works when both the string and function are used in one view", async function () {
    await this.template({
      "style.css": "body { color: red; }",
      "entries.html": "{{{cdn}}}|{{#cdn}}/style.css{{/cdn}}",
    });

    const text = await this.text("/");
    const [origin, cdnURL] = text.split("|");

    expect(origin).toBe(config.cdn.origin);
    validate(cdnURL);
  });

  it("works when both the string and multiple functions are used in one view", async function () {
    await this.template({
      "style.css": "body { color: red; }",
      "script.js": "alert('wow')",
      "entries.html":
        "{{#cdn}}/script.js{{/cdn}}|{{{cdn}}}|{{#cdn}}style.css{{/cdn}}",
    });

    const text = await this.text("/");
    const [jsCdnURL, origin, cssCdnURL] = text.split("|");

    expect(origin).toBe(config.cdn.origin);
    validate(jsCdnURL);
    validate(cssCdnURL);
  });

  it("works when the view references partials which use the string and function both", async function () {
    const template = {
      "a.css": "{{#cdn}}/c.css{{/cdn}}",
      "b.css": "{{{cdn}}}",
      "c.css": "body{color:#000}",
      "entries.html": "{{> a.css}}|{{> b.css}}",
    };

    await this.template(template);

    const text = await this.text("/");
    const [cssCdnURL, origin] = text.split("|");
    const hash = extractHash(cssCdnURL);

    expect(origin).toBe(config.cdn.origin);
    validate(cssCdnURL);

    await this.template({ ...template, "c.css": "body{color:#fff}" });

    const newHash = extractHash((await this.text("/")).split("|")[0]);

    expect(newHash).not.toBe(hash);
  });

  it("works without a leading slash", async function () {
    await this.template({
      "style.css": "body { color: red; }",
      "entries.html": "{{#cdn}}style.css{{/cdn}}",
    });

    validate(await this.text("/"));
  });

  it("updates the URL when the view changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}style.css{{/cdn}}`,
      "style.css": "body { color: red; }",
    };

    await this.template(template);

    const hash = extractHash(await this.text("/"));

    await this.template({
      ...template,
      "style.css": "body { color: purple; }",
    });

    const newHash = extractHash(await this.text("/"));

    expect(hash).not.toBe(newHash);
  });

  it("preserves the URL when there is a new post", async function () {
    await this.template({
      "entries.html": `{{#cdn}}style.css{{/cdn}}`,
      "style.css": "body { color: red; }",
    });

    const cdnURL = await this.text("/");
    validate(cdnURL);

    await this.write({ path: "/Hello.txt", content: "Hello" });

    const newCdnURL = await this.text("/");
    validate(newCdnURL);

    expect(cdnURL).toBe(newCdnURL);
  });

  it("changes when a referenced view changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "{{> rules.css}} body { color: red; }",
      "rules.css": "a {color: pink}",
    };

    await this.template(template);

    const hash = extractHash(await this.text("/"));

    await this.template({
      ...template,
      "rules.css": "a {color: blue}",
    });

    expect(hash).not.toBe(extractHash(await this.text("/")));
    expect(await this.text("/style.css")).toBe("a {color: blue} body { color: red; }");
  });

  it("changes when a deeply nested referenced view changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "{{> a.css}}",
      "a.css": "{{> b.css}}",
      "b.css": "{{> c.css}}",
      "c.css": "body{color:#fff}",
    };

    await this.template(template);

    const hash = extractHash(await this.text("/"));

    await this.template({
      ...template,
      "c.css": "body{color:#000}",
    });

    expect(hash).not.toBe(extractHash(await this.text("/")));
    expect(await this.text("/style.css")).toBe("body{color:#000}");
  });

  it("changes when a local used in a deeply nested referenced partial changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "{{> a.css}}",
      "a.css": "{{> b.css}}",
      "b.css": "{{> c.css}}",
      "c.css": "{{wow}}",
    };

    await this.template(template, { locals: { wow: "body{color:#000}" } });

    const hash = extractHash(await this.text("/"));

    await this.template(template, { locals: { wow: "body{color:#fff}" } });

    expect(hash).not.toBe(extractHash(await this.text("/")));
    expect(await this.text("/style.css")).toBe("body{color:#fff}");
  });

  it("preserves the URL when a non-referenced view changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "body { color: red; }",
      "robots.txt": "ignore",
    };

    await this.template(template);

    const hash = extractHash(await this.text("/"));

    await this.template({
      ...template,
      "robots.txt": "allow",
    });

    expect(hash).toBe(extractHash(await this.text("/")));
  });

  it("changes when a referenced local changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "{{{variable}}}",
    };

    await this.template(template, { locals: { variable: "x{color:red}" } });
    expect(await this.text("/style.css")).toBe("x{color:red}");

    const hash = extractHash(await this.text("/"));

    await this.template(template, { locals: { variable: "x{color:#00f}" } });
    expect(await this.text("/style.css")).toBe("x{color:#00f}");
    expect(hash).not.toBe(extractHash(await this.text("/")));
  });

  it("preserves the URL when a non-referenced local changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}/style.css{{/cdn}}`,
      "style.css": "body{color:pink}",
    };

    await this.template(template, { locals: { variable: "x" } });
    expect(await this.text("/style.css")).toBe("body{color:pink}");

    const hash = extractHash(await this.text("/"));

    await this.template(template, { locals: { variable: "y" } });
    expect(await this.text("/style.css")).toBe("body{color:pink}");
    expect(hash).toBe(extractHash(await this.text("/")));
  });

  it("updates the URL when the a view-specific partial changes", async function () {
    const template = {
      "entries.html": `{{#cdn}}style.css{{/cdn}}`,
      "style.css": "{{> x}}",
    };

    const package = {
      views: {
        "style.css": {
          partials: {
            x: "body{color:#000}",
          },
        },
      },
    };

    await this.template(template, package);

    const firstCdnUrl = await this.text("/");
    const firstHash = extractHash(firstCdnUrl);

    expect(await this.text(firstCdnUrl)).toBe("body{color:#000}");

    await this.template(template, {
      views: {
        "style.css": {
          partials: {
            x: "body{color:#fff}",
          },
        },
      },
    });

    const secondCdnUrl = await this.text("/");
    const secondHash = extractHash(secondCdnUrl);

    expect(await this.text(secondCdnUrl)).toBe("body{color:#fff}");

    expect(secondHash).not.toBe(firstHash);
  });

  it("should replace folder links in CSS served via template CDN route", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url('/images/test.jpg'); }`,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });
    // Get the CDN URL from the HTML
    const html = await this.text("/");
    const cdnUrlMatch = html.match(
      new RegExp(`${config.cdn.origin}/template/[^"']+`)
    );
    expect(cdnUrlMatch).toBeTruthy();
    const cdnUrl = cdnUrlMatch[0];
    // Fetch the CSS via CDN route
    const css = await this.text(cdnUrl);
    // Verify the URL in CSS was replaced with CDN URL
    expect(css).toMatch(cdnRegex("/images/test.jpg"));
    expect(css).not.toContain("url('/images/test.jpg')");
  });

  it("should handle relative URLs in CSS served via template CDN", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url(./images/test.jpg); }`,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });
    const html = await this.text("/");
    const cdnUrlMatch = html.match(
      new RegExp(`${config.cdn.origin}/template/[^"']+`)
    );
    const cdnUrl = cdnUrlMatch[0];
    const css = await this.text(cdnUrl);
    expect(css).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should not modify external URLs in CSS served via template CDN", async function () {
    await this.template({
      "style.css": `.test { background: url(https://example.com/image.jpg); }`,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });
    const html = await this.text("/");
    const cdnUrlMatch = html.match(
      new RegExp(`${config.cdn.origin}/template/[^"']+`)
    );
    const cdnUrl = cdnUrlMatch[0];
    const css = await this.text(cdnUrl);
    expect(css).toContain("url(https://example.com/image.jpg)");
  });

  it("should handle multiple URLs in CSS served via template CDN", async function () {
    await this.write({ path: "/img1.jpg", content: "image1" });
    await this.write({ path: "/img2.jpg", content: "image2" });
    await this.template({
      "style.css": `
        .test { 
          background-image: url(/img1.jpg);
          border-image: url(/img2.jpg);
        }`,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });
    const html = await this.text("/");
    const cdnUrlMatch = html.match(
      new RegExp(`${config.cdn.origin}/template/[^"']+`)
    );
    const cdnUrl = cdnUrlMatch[0];
    const css = await this.text(cdnUrl);
    expect(css).toMatch(cdnRegex("/img1.jpg"));
    expect(css).toMatch(cdnRegex("/img2.jpg"));
  });

  it("should handle URLs with query strings in CSS served via template CDN", async function () {
    await this.write({ path: "/image.jpg", content: "image" });
    await this.template({
      "style.css": `.test { background: url('/image.jpg?v=1'); }`,
      "entries.html": "{{#cdn}}/style.css{{/cdn}}",
    });
    const html = await this.text("/");
    const cdnUrlMatch = html.match(
      new RegExp(`${config.cdn.origin}/template/[^"']+`)
    );
    const cdnUrl = cdnUrlMatch[0];
    const css = await this.text(cdnUrl);
    expect(css).toMatch(cdnRegex("/image.jpg\\?v=1"));
  });

  it("resolves folder links in CSS files served via template CDN", async function () {
    await this.write({ path: "/images/1.jpg", content: "fake image data" });

    // Create template with CSS that references folder file
    await this.template({
      "style.css": `.test { background-image: url('/images/1.jpg'); }`,
      "entries.html": `<link rel="stylesheet" href="{{#cdn}}/style.css{{/cdn}}">`,
    });

    // Get the CDN URL from the rendered HTML
    const html = await this.text("/");
    const cdnUrlMatch = html.match(/href="([^"]+)"/);
    expect(cdnUrlMatch).toBeTruthy();
    const cdnUrl = cdnUrlMatch[1];

    // Verify it's a template CDN URL
    expect(cdnUrl).toContain(config.cdn.origin);
    expect(cdnUrl).toContain("/template/");

    // Fetch the CSS file from the CDN URL
    const cssContent = await this.text(cdnUrl);

    // Verify folder link was resolved to CDN URL
    expect(cssContent).toMatch(cdnRegex("/images/1.jpg"));
    expect(cssContent).not.toContain("url('/images/1.jpg')");
    expect(cssContent).not.toContain('url("/images/1.jpg")');
  });

  describe("path traversal security", function () {
    it("rejects path traversal in CDN route view names", async function () {
      await this.template({
        "style.css": "body { color: red; }",
        "entries.html": "{{#cdn}}/style.css{{/cdn}}",
      });

      // Get a valid CDN URL to extract the hash
      const cdnURL = await this.text("/");
      validate(cdnURL);

      // Extract hash from the CDN URL
      // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
      const hash = extractHash(cdnURL);
      const validHash = hash;
      const hashDir1 = validHash.substring(0, 2);
      const hashDir2 = validHash.substring(2, 4);
      const hashRemainder = validHash.substring(4);

      // Test various path traversal attempts in view names
      // The new format is /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
      // Path traversal should be rejected by the CDN route
      const pathTraversalAttempts = [
        "../style.css",
        "..%2Fstyle.css",
        "%2E%2E/style.css",
        "subdir/../../style.css",
        "..\\style.css",
      ];

      for (const maliciousPath of pathTraversalAttempts) {
        const encodedPath = encodeURIComponent(maliciousPath);
        // Use valid hash format, but with malicious view name
        const cdnPath = `/template/${hashDir1}/${hashDir2}/${hashRemainder}/${encodedPath}`;
        const fullCdnURL = new URL(cdnPath, config.cdn.origin).toString();
        const res = await this.fetch(fullCdnURL);
        // Should reject with 400 (invalid path), 403 (forbidden), or 404 (not found)
        expect([400, 403, 404]).toContain(res.status);
      }

      // Test null byte (encoded) in view name
      const nullBytePath = "style%00.css";
      const nullByteCdnPath = `/template/${hashDir1}/${hashDir2}/${hashRemainder}/${nullBytePath}`;
      const nullByteCdnURL = new URL(
        nullByteCdnPath,
        config.cdn.origin
      ).toString();
      const nullByteRes = await this.fetch(nullByteCdnURL);
      expect([400, 403, 404]).toContain(nullByteRes.status);
    });

    it("rejects path traversal in template CDN targets", async function () {
      // Test that templates with path traversal in CDN targets are rejected
      const maliciousTargets = [
        "../style.css",
        "..\\style.css",
        "subdir/../../style.css",
      ];

      for (const maliciousTarget of maliciousTargets) {
        await this.template({
          "style.css": "body { color: red; }",
          "entries.html": `{{#cdn}}/${maliciousTarget}{{/cdn}}`,
        });

        // The malicious target should be ignored, so the CDN URL should not be generated
        // Instead, it should return the raw path
        const result = await this.text("/");
        expect(result).toBe(`/${maliciousTarget}`);
        expect(result).not.toContain("/template/");
      }
    });

    it("rejects CDN targets with backslashes", async function () {
      await this.template({
        "style.css": "body { color: red; }",
        "entries.html": "{{#cdn}}/subdir\\style.css{{/cdn}}",
      });

      // Backslash should be rejected
      const result = await this.text("/");
      expect(result).toBe("/subdir\\style.css");
      expect(result).not.toContain("/template/");
    });

    it("rejects CDN targets with double slashes", async function () {
      await this.template({
        "style.css": "body { color: red; }",
        "entries.html": "{{#cdn}}//style.css{{/cdn}}",
      });

      // Double slash should be rejected (existing check)
      const result = await this.text("/");
      expect(result).toBe("//style.css");
      expect(result).not.toContain("/template/");
    });

    it("rejects CDN targets with spaces", async function () {
      await this.template({
        "style.css": "body { color: red; }",
        "entries.html": "{{#cdn}}/style .css{{/cdn}}",
      });

      // Space should be rejected (existing check)
      const result = await this.text("/");
      expect(result).toBe("/style .css");
      expect(result).not.toContain("/template/");
    });
  });

  describe("loadTemplate CDN manifest", function () {
    it("loads CDN manifest into template object", async function () {
      await this.template({
        "style.css": "body { color: red; }",
        "entries.html": "{{#cdn}}/style.css{{/cdn}}",
      });

      // The template should have CDN manifest loaded
      // This is tested indirectly by the CDN helper working
      const html = await this.text("/");
      expect(html).toContain("/template/");
      expect(html).toContain(config.cdn.origin);
    });

    it("handles missing CDN manifest gracefully", async function () {
      // Create a template without CDN manifest
      await this.template({
        "entries.html": "No CDN usage",
      });

      // Should not error
      const html = await this.text("/");
      expect(html).toBe("No CDN usage");
    });
  });
});
