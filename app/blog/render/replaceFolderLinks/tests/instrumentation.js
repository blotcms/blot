// The stats argument to html.js / css.js must observe the pass without
// changing it. These run the passes against real files on disk (lookupFile
// only touches the filesystem), so no running blog is needed.
describe("replaceFolderLinks instrumentation", function () {
  const config = require("config");
  const fs = require("fs-extra");
  const { join } = require("path");
  const replaceFolderLinks = require("../html");
  const replaceCssUrls = require("../css");
  const { createStats } = require("../stats");

  const blogID = "blog_instrumentation" + Date.now().toString(16);
  const blog = {
    id: blogID,
    cacheID: Date.now(),
    handle: "instrumentation",
    domain: "example.org",
  };
  const folder = join(config.blog_folder_dir, blogID);

  beforeAll(async function () {
    await fs.outputFile(join(folder, "images", "a.jpg"), "a");
    await fs.outputFile(join(folder, "images", "b.png"), "b");
  });

  afterAll(async function () {
    await fs.remove(folder);
  });

  const html = `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>
    <img src="/images/a.jpg">
    <img src="images/b.png">
    <img src="https://${blog.handle}.${config.host}/images/a.jpg">
    <img src="/images/missing.jpg">
    <img srcset="/images/a.jpg 1x, images/b.png 2x">
    <img src="https://elsewhere.com/images/a.jpg">
    <a href="/page.html">page</a>
  </body></html>`;

  it("returns byte-identical html with and without a stats object", async function () {
    const without = await replaceFolderLinks(blog, html, () => {});
    const stats = createStats("html");
    const withStats = await replaceFolderLinks(blog, html, () => {}, stats);

    expect(withStats).toEqual(without);
    expect(withStats).not.toEqual(html);
  });

  it("records html rewrites and missing files", async function () {
    const stats = createStats("html");
    await replaceFolderLinks(blog, html, () => {}, stats);

    expect(stats.parsed).toBe(true);
    expect(stats.rewrites.map((e) => e.original).sort()).toEqual(
      [
        "/images/a.jpg",
        "/images/a.jpg",
        "https://instrumentation." + config.host + "/images/a.jpg",
        "images/b.png",
        "images/b.png",
      ].sort()
    );
    expect(stats.rewrites.map((e) => e.form).sort()).toEqual(
      ["host", "relative", "relative", "root", "root"].sort()
    );
    expect(stats.enoent.map((e) => e.original).sort()).toEqual([
      "/images/missing.jpg",
      "/style.css",
    ]);
  });

  it("does not mark early exits as parsed or record anything", async function () {
    const stats = createStats("html");
    const plain = "<p>nothing to see</p>";

    expect(await replaceFolderLinks(blog, plain, () => {}, stats)).toEqual(plain);
    expect(stats.parsed).toBe(false);
    expect(stats.rewrites).toEqual([]);
    expect(stats.enoent).toEqual([]);
  });

  const css = `.a { background: url(/images/a.jpg) }
    .b { background: url('images/b.png') }
    .c { background: url("/images/missing.jpg") }
    .d { background: url(https://elsewhere.com/images/a.jpg) }`;

  it("returns byte-identical css with and without a stats object", async function () {
    const without = await replaceCssUrls(blog, css, () => {});
    const stats = createStats("css");
    const withStats = await replaceCssUrls(blog, css, () => {}, stats);

    expect(withStats).toEqual(without);
    expect(withStats).not.toEqual(css);
  });

  it("records css rewrites and missing files", async function () {
    const stats = createStats("css");
    await replaceCssUrls(blog, css, () => {}, stats);

    expect(stats.parsed).toBe(true);
    expect(stats.rewrites.map((e) => [e.original, e.form]).sort()).toEqual([
      ["/images/a.jpg", "root"],
      ["images/b.png", "relative"],
    ]);
    expect(stats.enoent.map((e) => e.original)).toEqual(["/images/missing.jpg"]);
  });
});
