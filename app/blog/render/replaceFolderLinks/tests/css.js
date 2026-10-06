describe("replaceCssUrls", function () {
  require("blog/tests/util/setup")();

  const config = require("config");
  const fs = require("fs-extra");
  const cdnRegex = (path) =>
    new RegExp(
      `${config.cdn.origin}/folder/v-[a-f0-9]{8}/blog_[a-f0-9]+${path}`
    );
  const globalStaticFileRegex = (path) =>
    new RegExp(`${config.cdn.origin}${path}`);

  it("should replace url() with versioned CDN URLs", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url('/images/test.jpg'); }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle no quotes", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url(/images/test.jpg); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle single quotes", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url('/images/test.jpg'); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle double quotes", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url("/images/test.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle spaces and url-encoded chars", async function () {
    await this.write({ path: "/image with space.jpg", content: "image" });
    await this.template({
      "style.css": `.test { background-image: url("/image%20with%20space.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(
      cdnRegex("/image%20with%20space.jpg")
    );
  });

  it("should handle file names with percent signs", async function () {
    await this.write({ path: "/100% luck.jpg", content: "image" });
    await this.template({
      "style.css": `.test { background-image: url("/100% luck.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/100%25%20luck.jpg"));
  });

  it("should handle unquoted URLs", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background: url(/images/test.jpg); }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle full urls to the blot subdomain", async function () {
    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url("https://${this.blog.handle}.${config.host}/images/test.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
    await this.template({
      "style.css": `.test { background-image: url("https://www.${this.blog.handle}.${config.host}/images/test.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle full urls to a custom domain", async function () {
    await this.blog.update({
      domain: "example.com",
      redirectSubdomain: false,
    });

    await this.write({ path: "/images/test.jpg", content: "fake image data" });
    await this.template({
      "style.css": `.test { background-image: url("https://example.com/images/test.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
    await this.template({
      "style.css": `.test { background-image: url("https://www.example.com/images/test.jpg"); }`,
    });
    expect(await this.text("/style.css")).toMatch(cdnRegex("/images/test.jpg"));
  });

  it("should handle multiple URLs in the same rule across multiple requests", async function () {
    await this.write({ path: "/img1.jpg", content: "image1" });
    await this.write({ path: "/img2.jpg", content: "image2" });
    await this.template({
      "style.css": `
          .test { 
            background-image: url(/img1.jpg);
            border-image: url(/img2.jpg);
          }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/img1.jpg"));
    expect(result).toMatch(cdnRegex("/img2.jpg"));

    const result2 = await this.text("/style.css");

    expect(result2).toMatch(cdnRegex("/img1.jpg"));
    expect(result2).toMatch(cdnRegex("/img2.jpg"));
  });

  it("should not modify external URLs", async function () {
    const css = `.test{background:url(http://example.com/image.jpg);background-image:url(https://example.com/image.png)}`;
    await this.template({ "style.css": css });

    const result = await this.text("/style.css");

    expect(result).toEqual(css);
  });

  it("should handle font-face rules with incorrect case", async function () {
    const trioCSS = `    
    @font-face {
      font-family: 'Trio Grotesk';
      font-weight: 400;
      font-style: normal;
      src: url('/templates/fonts/trio.grotesk/triogrotesk-regular.otf') format('opentype'); 
    }
    
    @font-face {
      font-family: 'Trio Grotesk';
      font-weight: 400;
      font-style: italic;
      src: url('/templates/fonts/trio.grotesk/triogrotesk-italic.otf') format('opentype'); 
    }`;

    await this.template({
      "style.css": trioCSS,
    });

    await this.write({
      path: "/Templates/Fonts/trio.grotesk/triogrotesk-regular.otf",
      content: "fake font data",
    });
    await this.write({
      path: "/Templates/Fonts/trio.grotesk/triogrotesk-italic.otf",
      content: "fake font data",
    });

    const result = await this.text("/style.css");
    expect(result).toMatch(
      cdnRegex("/Templates/Fonts/trio.grotesk/triogrotesk-regular.otf")
    );
    expect(result).toMatch(
      cdnRegex("/Templates/Fonts/trio.grotesk/triogrotesk-italic.otf")
    );

    const result2 = await this.text("/style.css");
    expect(result2).toMatch(
      cdnRegex("/Templates/Fonts/trio.grotesk/triogrotesk-regular.otf")
    );
    expect(result2).toMatch(
      cdnRegex("/Templates/Fonts/trio.grotesk/triogrotesk-italic.otf")
    );
  });

  it("should not modify data URLs", async function () {
    const css = `.test{background:url(data:image/png;base64,abc123)}`;
    await this.template({ "style.css": css });

    const result = await this.text("/style.css");

    expect(result).toEqual(css);
  });

  it("should handle missing files gracefully", async function () {
    const css = `.test{background:url(/nonexistent.jpg)}`;
    await this.template({ "style.css": css });

    const result = await this.text("/style.css");

    expect(result).toEqual(css);
  });

  it("should preserve other CSS properties", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "style.css": `
          .test { 
            color:red; 
            background:url(/test.jpg) center/cover; 
            margin:10px;
          }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(/color:red/);
    expect(result).toMatch(/center\/cover;/);
    expect(result).toMatch(/margin:10px/);
    expect(result).toMatch(cdnRegex("/test.jpg"));
  });

  it("should handle query strings", async function () {
    await this.write({ path: "/image.jpg", content: "image" });
    await this.template({
      "style.css": `.test { background: url('/image.jpg?v=1'); }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/image.jpg\\?v=1"));
  });

  it("should use cached versions for repeated requests", async function () {
    await this.write({ path: "/cached.jpg", content: "image" });
    await this.template({
      "style.css": `.test { background: url(/cached.jpg); }`,
    });

    const filePath = this.blogDirectory + "/cached.jpg";

    const origStat = fs.stat;
    fs.stat = jasmine.createSpy("stat").and.callFake(origStat);

    // First request
    const result1 = await this.text("/style.css");

    expect(fs.stat).toHaveBeenCalledWith(filePath);
    expect(fs.stat.calls.count()).toBe(1);

    fs.stat.calls.reset();

    // Second request
    const result2 = await this.text("/style.css");

    expect(result1).toEqual(result2);
    expect(fs.stat).not.toHaveBeenCalled();

    fs.stat = origStat;
  });

  it("should handle multiple backgrounds with fallbacks", async function () {
    await this.write({ path: "/bg1.jpg", content: "image1" });
    await this.write({ path: "/bg2.jpg", content: "image2" });
    await this.template({
      "style.css": `
          .test { 
            background-image: url(/bg1.jpg), url(/bg2.jpg);
          }`,
    });

    const result = await this.text("/style.css");

    const matches = result.match(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}`, "g")
    );
    expect(matches.length).toEqual(2);
  });

  it("ignores path traversal attempts", async function () {
    const css = `.test{background:url(../../../../etc/passwd)}`;
    await this.template({ "style.css": css });

    const result = await this.text("/style.css");

    expect(result).toEqual(css);
  });

  it("can handle whitespace unlike postcss", async function () {
    const css = `@media screen and (max-width: 400px) {
  
  .wide {background: url(/test.jpg);}

 }
`;
    await this.template({ "style.css": css });
    await this.write({ path: "/test.jpg", content: "image" });

    const result = await this.text("/style.css");
    expect(result).toMatch(cdnRegex("/test.jpg"));
  });

  it("should handle relative paths", async function () {
    await this.write({ path: "/a.jpg", content: "image" });
    await this.write({ path: "/b.jpg", content: "image" });
    await this.write({
      path: "/Type/valkyrie_b_bold_italic.woff2",
      content: "image",
    });
    await this.template({
      "style.css": `
          .test { 
            background: url(./a.jpg);
            border-image: url(b.jpg);
            background-image: url('../c.jpg') format('webp');
          }

          @font-face{font-family:valkyrie_b;font-style:italic;font-weight:700;font-stretch:normal;font-display:auto;src:url('../Type/valkyrie_b_bold_italic.woff2') format('woff2')}
            `,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/a.jpg"));
    expect(result).toMatch(cdnRegex("/b.jpg"));
    expect(result).toMatch(cdnRegex("/Type/valkyrie_b_bold_italic.woff2"));
  });

  it("should change the CDN url if the source file changes", async function () {
    await this.write({ path: "/test.jpg", content: "image 1" });
    await this.template({ "style.css": `.test {background: url(./test.jpg)}` });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/test.jpg"));

    const version = result.match(/v-[a-f0-9]{8}/)[0];

    // wait one second to ensure the file is written at a different time
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await this.write({ path: "/test.jpg", content: "image 2" });

    const result2 = await this.text("/style.css");

    expect(result2).toMatch(cdnRegex("/test.jpg"));

    const version2 = result2.match(/v-[a-f0-9]{8}/)[0];

    expect(version2).not.toEqual(version);
  });

  it("should handle @media queries", async function () {
    await this.write({ path: "/mobile.jpg", content: "image" });
    await this.template({
      "style.css": `@media (max-width:768px){.test{background-image:url(https://cdn.localhost/folder/v-e464a519/blog_2c245d7ded644f2380a75cdcf260a603/mobile.jpg)}}`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/mobile.jpg"));
    expect(result).toMatch(/@media \(max-width:768px\)/);
  });

  it("should handle URLs with special characters", async function () {
    await this.write({ path: "/image with spaces.jpg", content: "image" });
    await this.write({ path: "/image.jpg", content: "image" });
    await this.template({
      "style.css": `
        .test { 
          background: url('/image with spaces.jpg');
          border-image: url('/image.jpg#hash');
        }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/image%20with%20spaces.jpg"));
    expect(result).toMatch(cdnRegex("/image.jpg"));
  });

  it("should handle malformed URL syntax", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    const css = `
      .test { 
        background: url(/test.jpg;
        border: url('test.jpg);
        content: url("test.jpg;
      }`;
    await this.template({ "style.css": css });

    const result = await this.text("/style.css");

    expect(result).toEqual(css);
  });

  it("should handle multiple nested @rules", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "style.css": `
        @media print {
          @supports (display: grid) {
            @media (max-width: 600px) {
              .test { background: url(/test.jpg); }
            }
          }
        }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/test.jpg"));
    expect(result).toMatch(/@media print/);
    expect(result).toMatch(/@supports/);
  });

  it("should handle URL lists in custom properties", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "style.css": `
        :root {
          --bg-images: url(/test.jpg), linear-gradient(red, blue);
        }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/test.jpg"));
    expect(result).toMatch(/linear-gradient\(red, blue\)/);
  });

  it("should handle concurrent requests for different files", async function () {
    await this.write({ path: "/1.jpg", content: "image1" });
    await this.write({ path: "/2.jpg", content: "image2" });
    await this.write({ path: "/3.jpg", content: "image3" });

    const template = {};

    for (let i = 1; i <= 3; i++) {
      template[`style${i}.css`] = `.test { background-image: url(/${i}.jpg); }`;
    }

    await this.template(template);

    const promises = [1, 2, 3].map(async (n) => {
      const res = await this.get(`/style${n}.css`);
      return res;
    });

    const results = await Promise.all(promises);
    const texts = await Promise.all(results.map((r) => r.text()));

    texts.forEach((text, i) => {
      expect(text).toMatch(cdnRegex(`/${i + 1}.jpg`));
    });
  });

  it("should handle URLs with fragments", async function () {
    await this.write({ path: "/sprite.svg", content: "<svg>...</svg>" });
    await this.template({
      "style.css": `.test { mask-image: url(/sprite.svg#icon-home); }`,
    });

    const result = await this.text("/style.css");

    expect(result).toMatch(cdnRegex("/sprite.svg"));
  });

  it("should handle CSS comments containing URLs", async function () {
    await this.write({ path: "/test.jpg", content: "image" });
    await this.template({
      "style.css": `
        /* background: url(/test.jpg); */
        .test { background: url(/test.jpg); }`,
    });

    const result = await this.text("/style.css");

    const matches = result.match(cdnRegex("/test.jpg"));
    expect(matches.length).toBe(1); // Should only replace the actual URL, not the one in comments
  });

  it("should handle global static files", async function () {
    await this.write({
      path: "/plugins/katex/files/test.jpg",
      content: "fake image data",
    });
    await this.template({
      "style.css": `.test { background-image: url('/plugins/katex/files/test.jpg'); }
      @font-face{font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(/plugins/katex/files/KaTeX_AMS-Regular.ttf) format("ttf")}`,
    });
    expect(await this.text("/style.css")).toMatch(
      cdnRegex("/plugins/katex/files/test.jpg")
    );

    expect(await this.text("/style.css")).toMatch(
      globalStaticFileRegex("/plugins/katex/files/KaTeX_AMS-Regular.ttf")
    );
  });

  it("should use cached versions for repeated requests to global static files", async function () {
    await this.template({
      "style.css": `@font-face{font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:url(/plugins/katex.woff2) format("woff2")}`,
    });

    await fs.outputFile(
      config.blot_directory + "/app/blog/static/plugins/katex.woff2",
      "fake image data"
    );

    const origStat = fs.stat;

    fs.stat = jasmine.createSpy("stat").and.callFake(origStat);

    // First request
    const result1 = await this.text("/style.css");

    expect(result1).toMatch(globalStaticFileRegex("/plugins/katex.woff2"));

    expect(fs.stat).toHaveBeenCalledWith(
      config.blot_directory + "/app/blog/static/plugins/katex.woff2"
    );
    expect(fs.stat.calls.count()).toBe(1);

    fs.stat.calls.reset();

    // Second request
    const result2 = await this.text("/style.css");

    expect(result1).toEqual(result2);
    expect(fs.stat).not.toHaveBeenCalled();

    fs.stat = origStat;

    await fs.remove(
      config.blot_directory + "/app/blog/static/plugins/katex.woff2"
    );
  });
});
