describe("wordpress export", function () {
  global.test.site({ login: true });

  it("resolves %%BLOT_CDN%% tokens baked into entry HTML", async function () {
    const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
    const config = require("config");

    await this.blog.write({ path: "/report.pdf", content: "fake pdf data" });
    await this.blog.write({
      path: "/post.txt",
      content: "# Post\n\n[Report](report.pdf)",
    });
    await this.blog.rebuild();

    const xml = await this.text(`/sites/${this.blog.handle}/export/wordpress`);

    expect(xml).not.toContain(BLOT_CDN_TOKEN);
    // A non-image file avoids the (slow) image optimizer: folderAssets
    // bakes the link, and the export must hold a resolved CDN URL.
    expect(xml).toContain(config.cdn.origin);
  }, 20000);
});
