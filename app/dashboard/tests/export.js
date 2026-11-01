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

describe("zip export", function () {
  global.test.site({ login: true });

  it("includes every file in the blog's folder", async function () {
    const yauzl = require("yauzl");

    await this.blog.write({ path: "/notes/nested/a.txt", content: "a" });
    await this.blog.write({ path: "/b.txt", content: "b" });

    const res = await this.get(`/sites/${this.blog.handle}/export/download`);
    expect(res.status).toBe(200);

    const zip = Buffer.from(await res.arrayBuffer());
    const names = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        const found = [];
        zipfile.on("entry", (entry) => {
          found.push(entry.fileName);
          zipfile.readEntry();
        });
        zipfile.on("end", () => resolve(found));
        zipfile.on("error", reject);
        zipfile.readEntry();
      });
    });

    expect(names).toContain("blog.json");
    expect(names).toContain("folder/b.txt");
    expect(names).toContain("folder/notes/nested/a.txt");
  }, 20000);
});
