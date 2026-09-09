describe("replaceFolderLinks", function () {
  require("blog/tests/util/setup")();

  const config = require("config");
  const fs = require("fs-extra");
  const cdnRegex = (path) =>
    new RegExp(
      `${config.cdn.origin}/folder/v-[a-f0-9]{8}/blog_[a-f0-9]+${path}`
    );

  it("should replace src attributes with versioned CDN URLs", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "entries.html": '<img src="/images/test.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/test.jpg">`
      )
    );
  });

  it("should replace poster attributes with versioned CDN URLs", async function () {
    await this.write({ path: "/images/poster.jpg", content: "fake image data" });
    await this.template({
      "entries.html": '<video poster="/images/poster.jpg"></video>',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<video poster="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/poster.jpg"></video>`
      )
    );
  });

  it("should be case-insensitive", async function () {
    await this.write({ path: "/Images/Test.jpg", content: "fake image data" });
    await this.template({
      "entries.html": '<img src="/iMaGeS/TeSt.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/Images/Test.jpg">`
      )
    );
  });

  it("should change the CDN url if the source file changes", async function () {
    await this.write({ path: "/test.jpg", content: "image 1" });
    await this.template({ "entries.html": '<img src="/test.jpg">' });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/test.jpg"));

    const version = result.match(/v-[a-f0-9]{8}/)[0];

    // wait one second to ensure the file is written at a different time
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await this.write({ path: "/test.jpg", content: "image 2" });

    const result2 = await this.text("/");

    expect(result2).toMatch(cdnRegex("/test.jpg"));

    const version2 = result2.match(/v-[a-f0-9]{8}/)[0];

    expect(version2).not.toEqual(version);
  });

  it("should leave code blocks as-is", async function () {
    await this.write({ path: "/docs/test.pdf", content: "fake pdf data" });
    await this.write({
      path: "/post.txt",
      content: '```html\n<a href="/docs/test.pdf">Download</a>\n```',
    });
    await this.template({
      "entries.html": "{{#entries}}{{{html}}}{{/entries}}",
    });

    const result = await this.text("/");

    expect(result).not.toContain(config.cdn.origin);
    expect(result).toContain(
      '<span class="hljs-string">"/docs/test.pdf"</span>'
    );
  });

  it("should replace src attributes with full qualified URLs to the blog custom domain", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.blog.update({
      domain: "example.com",
      redirectSubdomain: false,
    });

    await this.template({
      "entries.html": '<img src="https://example.com/images/test.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/test.jpg">`
      )
    );

    // handle www subdomain
    await this.template({
      "entries.html": '<img src="https://www.example.com/images/test.jpg">',
    });

    const result2 = await this.text("/");

    expect(result2).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/test.jpg">`
      )
    );
  });

  it("should replace src attributes with full qualified URLs to the blog subdomain", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "entries.html":
        '<img src="https://' +
        this.blog.handle +
        "." +
        config.host +
        '/images/test.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/test.jpg">`
      )
    );

    await this.template({
      "entries.html":
        '<img src="https://www.' +
        this.blog.handle +
        "." +
        config.host +
        '/images/test.jpg">',
    });

    const result2 = await this.text("/");

    expect(result2).toMatch(
      new RegExp(
        `<img src="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/test.jpg">`
      )
    );
  });


  it("should replace href attributes with versioned CDN URLs", async function () {
    await this.write({ path: "/docs/test.pdf", content: "fake pdf data" });
    await this.template({
      "entries.html": '<a href="/docs/test.pdf">Download</a>',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<a href="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/docs/test.pdf">Download</a>`
      )
    );
  });

  it("should not modify HTML file links", async function () {
    await this.template({
      "entries.html": '<a href="/page.html">Link</a>',
    });

    const result = await this.text("/");

    expect(result).toEqual('<a href="/page.html">Link</a>');
  });

  it("should handle multiple replacements in the same document", async function () {
    await this.write({ path: "/img1.jpg", content: "image1" });
    await this.write({ path: "/img2.jpg", content: "image2" });
    await this.template({
      "entries.html": '<div><img src="/img1.jpg"><img src="/img2.jpg"></div>',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`)
    );
    expect(
      result.match(new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`, "g"))
        .length
    ).toEqual(2);
  });

  it("should preserve full HTML document structure", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "entries.html": `
                  <!DOCTYPE html>
                  <html>
                      <head><title>Test</title></head>
                      <body><img src="/test.jpg"></body>
                  </html>
              `.trim(),
    });

    const result = await this.text("/");

    expect(result).toMatch(/<!DOCTYPE html>/);
    expect(result).toMatch(/<html>/);
    expect(result).toMatch(/<head>/);
    expect(result).toMatch(/<body>/);
    expect(result).toMatch(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`)
    );
  });

  it("should handle missing files gracefully, even across multiple requests", async function () {
    await this.template({
      "entries.html": '<img src="/nonexistent.jpg">',
    });

    const result = await this.text("/");

    expect(result).toEqual('<img src="/nonexistent.jpg">');

    const result2 = await this.text("/");

    expect(result2).toEqual('<img src="/nonexistent.jpg">');
  });

  it("skips external hrefs and srcs", async function () {
    await this.write({ path: "/a.jpg", content: "image" });
    await this.write({ path: "/b.jpg", content: "image" });
    await this.template({
      "entries.html":
        '<img src="http://example.com/a.jpg"><a href="https://example.com/b.jpg">',
    });

    const result = await this.text("/");

    expect(result).toEqual(
      '<img src="http://example.com/a.jpg"><a href="https://example.com/b.jpg">'
    );
  });

  it("ignores path traversal attacks", async function () {
    await this.template({
      "entries.html": `<img src="../../../../a.jpg"><a href="../../../../etc/passwd">`,
    });

    const result = await this.text("/");

    expect(result).toEqual(
      '<img src="../../../../a.jpg"><a href="../../../../etc/passwd">'
    );
  });

  it("should replace src attributes on source and track elements", async function () {
    await this.write({ path: "/images/picture.jpg", content: "fake image data" });
    await this.write({ path: "/media/video.mp4", content: "fake video data" });
    await this.write({ path: "/media/audio.mp3", content: "fake audio data" });
    await this.write({ path: "/media/subtitles.vtt", content: "fake vtt data" });
    await this.template({
      "entries.html": `
        <picture>
          <source src="/images/picture.jpg" type="image/jpeg">
          <img src="/images/picture.jpg">
        </picture>
        <video>
          <source src="/media/video.mp4" type="video/mp4">
          <track src="/media/subtitles.vtt" kind="subtitles">
        </video>
        <audio>
          <source src="/media/audio.mp3" type="audio/mpeg">
        </audio>
      `.trim(),
    });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/images/picture.jpg"));
    expect(result).toMatch(cdnRegex("/media/video.mp4"));
    expect(result).toMatch(cdnRegex("/media/subtitles.vtt"));
    expect(result).toMatch(cdnRegex("/media/audio.mp3"));
  });

  it("should rewrite srcset candidates with descriptors", async function () {
    await this.write({ path: "/img-1.jpg", content: "image1" });
    await this.write({ path: "/img-2.jpg", content: "image2" });
    await this.template({
      "entries.html": '<img srcset="/img-1.jpg 1x, /img-2.jpg 2x">',
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img srcset="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/img-1.jpg 1x, ${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/img-2.jpg 2x">`
      )
    );
  });

  it("should handle srcset attributes on source elements", async function () {
    await this.write({ path: "/images/picture-1.jpg", content: "fake image data" });
    await this.template({
      "entries.html": `
        <picture>
          <source srcset="/images/picture-1.jpg 1x" type="image/jpeg">
        </picture>
      `.trim(),
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<source srcset="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/picture-1.jpg 1x" type="image/jpeg">`
      )
    );
  });

  it("should rewrite host-matching absolute srcset URLs", async function () {
    await this.write({ path: "/images/abs.jpg", content: "image" });
    await this.template({
      "entries.html": `<img srcset="https://${this.blog.handle}.${config.host}/images/abs.jpg 1x">`,
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(
        `<img srcset="${config.cdn.origin}/folder/v-[a-f0-9]{8}/[^"]+/images/abs.jpg 1x">`
      )
    );
  });

  it("should leave malformed srcset attributes unchanged", async function () {
    await this.template({
      "entries.html": '<img srcset=", /img.jpg 1x">',
    });

    const result = await this.text("/");

    expect(result).toEqual('<img srcset=", /img.jpg 1x">');
  });
  
  it("ignores empty hrefs and srcs", async function () {
    await this.template({
      "entries.html": '<img src=""><a href="">',
    });

    const result = await this.text("/");

    expect(result).toEqual('<img src=""><a href="">');
  });

  it("handles relative paths", async function () {
    await this.write({ path: "/a.jpg", content: "image" });
    await this.write({ path: "/b.jpg", content: "image" });
    await this.write({ path: "/c.jpg", content: "image" });
    await this.template({
      "entries.html":
        '<img src="./a.jpg"><img src="b.jpg"><img src="../c.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/a.jpg"));
    expect(result).toMatch(cdnRegex("/b.jpg"));
    expect(result).toMatch(cdnRegex("/c.jpg"));
  });

  it("should handle spaces and url-encoded chars", async function () {
    await this.write({ path: "/image with space.jpg", content: "image" });
    await this.template({
      "entries.html": '<img src="/image%20with%20space.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/image with space.jpg"));
  });

  it("should handle file names with percent signs", async function () {
    await this.write({ path: "/100% luck.jpg", content: "image" });
    await this.template({
      "entries.html": '<img src="/100% luck.jpg">',
    });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/100% luck.jpg"));
  });

  it("should handle query strings", async function () {
    await this.write({ path: "/image.jpg", content: "image" });
    await this.template({
      "entries.html": '<img src="/image.jpg?cache=false">',
    });

    const result = await this.text("/");

    expect(result).toMatch(cdnRegex("/image.jpg\\?cache=false"));
  });

  it("should use cached versions for repeated requests", async function () {
    await this.write({ path: "/cached.jpg", content: "image" });
    await this.template({
      "entries.html": '<img src="/cached.jpg">',
    });

    const filePath = this.blogDirectory + "/cached.jpg";

    const origStat = fs.stat;
    fs.stat = jasmine.createSpy("stat").and.callFake(origStat);

    // First request should trigger a stat
    const result1 = await this.text("/");

    // Should have called stat once
    expect(fs.stat).toHaveBeenCalledWith(filePath);
    expect(fs.stat.calls.count()).toBe(1);

    // Reset the spy count
    fs.stat.calls.reset();

    // Second request should use cache
    const result2 = await this.text("/");

    // Verify responses match
    expect(result1).toEqual(result2);

    // Verify stat was not called again
    expect(fs.stat).not.toHaveBeenCalled();

    // Restore original stat
    fs.stat = origStat;
  });

  it("should use cached versions for different query strings", async function () {
    await this.write({ path: "/cached.jpg", content: "image" });
    await this.template({
      "1.html": '<img src="/cached.jpg">',
      "2.html": '<img src="/cached.jpg?cache=false">',
    });

    const filePath = this.blogDirectory + "/cached.jpg";

    const origStat = fs.stat;
    fs.stat = jasmine.createSpy("stat").and.callFake(origStat);

    // First request should trigger a stat
    const result1 = await this.text("/1.html");

    expect(result1).toMatch(cdnRegex("/cached.jpg"));
    // Should have called stat once
    expect(fs.stat).toHaveBeenCalledWith(filePath);
    expect(fs.stat.calls.count()).toBe(1);

    // Reset the spy count
    fs.stat.calls.reset();

    // Second request should use cache
    const result2 = await this.text("/2.html");

    // Verify stat was not called again
    expect(fs.stat).not.toHaveBeenCalled();
    expect(result2).toMatch(cdnRegex("/cached.jpg\\?cache=false"));

    // Restore original stat
    fs.stat = origStat;
  });

  it("should handle multiple attributes in the same tag", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "entries.html": '<img src="/test.jpg" data-src="/test.jpg">',
    });

    const result = await this.text("/");

    const matches = result.match(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`, "g")
    );
    expect(matches.length).toEqual(1); // Should only replace src, not data-src
  });

  it("should handle nested elements correctly", async function () {
    await this.write({ path: "/deep/nested/test.jpg", content: "image" });
    await this.template({
      "entries.html": `
                  <div>
                      <section>
                          <article>
                              <img src="/deep/nested/test.jpg">
                          </article>
                      </section>
                  </div>
              `.trim(),
    });

    const result = await this.text("/");

    expect(result).toMatch(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`)
    );
    expect(result).toMatch(/\/deep\/nested\/test.jpg/);
  });

  it("should preserve large base64 data URIs without locking up", async function () {
    // A data URI big enough to expose catastrophic regex backtracking, but
    // comfortably under the HTML post source size limit (see
    // build/converters/post-source-size.js) so the source still becomes an
    // entry.
    const oneMB = 1000 * 1000; // bytes of raw data -> ~1.33 MB once base64-encoded
    const randomData = Buffer.alloc(oneMB, "A"); // Fill with 'A' characters
    const base64Data = randomData.toString("base64");
    const dataUri = `data:image/png;base64,${base64Data}`;

    await this.write({ path: "/test.html", content: `<img src="${dataUri}">` });
    await this.template({
      "entries.html": `{{#entries}}{{{html}}}{{/entries}}`,
    });

    expect(await this.text("/")).toContain(dataUri);
  });
});
