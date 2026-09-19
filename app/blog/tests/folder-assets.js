describe("build-time baked folder links", function () {
  require("blog/tests/util/setup")();
  const config = require("config");
  const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  const versionOf = (body, file) => {
    const match = body.match(
      new RegExp(`/folder/(v-[a-f0-9]{8})/[^"'\\s]*${file}`)
    );
    return match && match[1];
  };

  it("re-versions poster and srcset files when they change", async function () {
    await this.template({ "entry.html": "{{{entry.html}}}" });
    await this.write({ path: "/poster.jpg", content: "poster one" });
    await this.write({ path: "/big.jpg", content: "big one" });
    await this.write({
      path: "/media.txt",
      content:
        'Link: /media\n\n<video poster="/poster.jpg"></video>\n\n<img src="/big.jpg" srcset="/big.jpg 2x">',
    });

    const before = await this.text("/media");
    const posterBefore = versionOf(before, "poster\\.jpg");

    expect(posterBefore).toBeTruthy();
    expect(before).not.toContain(BLOT_CDN_TOKEN);

    await this.write({ path: "/poster.jpg", content: "poster two" });

    const after = await this.text("/media");

    expect(versionOf(after, "poster\\.jpg")).not.toEqual(posterBefore);
  });

  it("gives a wikilink embed a fresh version when the embedded entry's image changes", async function () {
    await this.template({ "entry.html": "{{{entry.html}}}" });
    await this.write({ path: "/photo.jpg", content: "photo one" });
    await this.write({
      path: "/Snippets/B.md",
      content: "Link: snippets/b\n\n![](/photo.jpg)",
    });
    await this.blog.rebuild();
    await this.write({
      path: "/Pages/A.md",
      content: "Link: pages/a\n\n![[Snippets/B]]",
    });
    await this.blog.rebuild();

    const before = await this.text("/pages/a");
    const versionBefore = versionOf(before, "photo\\.jpg");

    expect(before).toContain('class="embedded-markdown"');
    expect(versionBefore).toBeTruthy();

    // No blog.rebuild() here: A must be rebuilt by rebuildDependents,
    // which only happens if the plugin recorded /photo.jpg as A's dependency.
    const json = await (await this.get("/pages/a?json=true")).json();

    expect(json.entry.dependencies).toContain("/photo.jpg");

    await this.write({ path: "/photo.jpg", content: "photo two" });

    const after = await this.text("/pages/a");

    expect(versionOf(after, "photo\\.jpg")).toBeTruthy();
    expect(versionOf(after, "photo\\.jpg")).not.toEqual(versionBefore);
  });

  it("bakes a link to a file that didn't exist at build time once it appears", async function () {
    await this.template({ "entry.html": "{{{entry.html}}}" });
    await this.write({
      path: "/late.txt",
      content: "Link: /late\n\n[Report](/report.pdf)",
    });

    const before = await this.text("/late");

    expect(before).toContain('href="/report.pdf"');
    expect(before).not.toContain("/folder/v-");

    // the missing file is still a dependency, so creating it rebuilds the entry
    const json = await (await this.get("/late?json=true")).json();

    expect(json.entry.dependencies).toContain("/report.pdf");

    await this.write({ path: "/report.pdf", content: "pdf one" });

    const after = await this.text("/late");
    const version = versionOf(after, "report\\.pdf");

    expect(version).toBeTruthy();
    expect(after).not.toContain(BLOT_CDN_TOKEN);

    const stored = await (await this.get("/late?json=true")).json();

    // baked into the stored entry, not just resolved at request time
    expect(stored.entry.html).toContain(`/folder/${version}/`);
  });

  it("falls back to the plain path when a baked file is deleted", async function () {
    await this.template({ "entry.html": "{{{entry.html}}}" });
    await this.write({ path: "/photo.jpg", content: "photo one" });
    await this.write({
      path: "/Snippets/B.md",
      content: "Link: snippets/b\n\n![](/photo.jpg)",
    });
    await this.blog.rebuild();
    await this.write({
      path: "/Pages/A.md",
      content: "Link: pages/a\n\n![[Snippets/B]]",
    });
    await this.blog.rebuild();

    expect(versionOf(await this.text("/pages/a"), "photo\\.jpg")).toBeTruthy();

    await this.remove("/photo.jpg");

    const after = await this.text("/pages/a");

    expect(after).not.toContain("/folder/v-");
    expect(after).not.toContain(BLOT_CDN_TOKEN);
    expect(after).toContain('src="/photo.jpg"');

    const json = await (await this.get("/pages/a?json=true")).json();

    expect(json.entry.dependencies).toContain("/photo.jpg");
  });

  it("resolves baked links in RSS feeds instead of leaking the token", async function () {
    await this.template({
      "feed.rss": "{{#recent_entries}}{{{body}}}{{/recent_entries}}",
    });
    await this.write({ path: "/photo.jpg", content: "photo" });
    await this.write({ path: "/post.txt", content: "![Image](photo.jpg)" });

    const feed = await this.text("/feed.rss");

    expect(feed).not.toContain(BLOT_CDN_TOKEN);
    expect(feed).toContain(`${config.cdn.origin}/folder/v-`);
  });
});
