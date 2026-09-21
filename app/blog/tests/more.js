describe("{{more}} teaser marker", function () {
  require("./util/setup")();

  it("does not appear in the rendered entry HTML or the teaser", async function () {
    await this.write({
      path: "/a.txt",
      content: "Link: a\n\nBefore the break\n\n{{more}}\n\nAfter the break",
    });
    await this.template({
      "entry.html": `{{#entry}}{{{html}}}{{/entry}}`,
      "entries.html": `{{#entries}}{{{teaser}}}{{/entries}}`,
    });

    const entry = await this.text("/a");
    const teaser = await this.text("/");

    expect(entry).toContain("Before the break");
    expect(entry).toContain("After the break");
    expect(entry).not.toContain("{{more}}");

    expect(teaser).toContain("Before the break");
    expect(teaser).not.toContain("After the break");
    expect(teaser).not.toContain("{{more}}");
  });

  it("is stripped from body, teaserBody and summary, and sets more", async function () {
    await this.write({
      path: "/a.txt",
      content: "Link: a\n\n# Title\n\nBefore the break\n\n{{more}}\n\nAfter the break",
    });
    await this.template({
      "entry.html": `{{#entry}}[{{{body}}}][{{more}}]{{/entry}}`,
      "entries.html": `{{#entries}}[{{{teaserBody}}}]|[{{summary}}]|[{{more}}]{{/entries}}`,
    });

    const entry = await this.text("/a");
    const list = await this.text("/");

    expect(entry).toContain("After the break");
    expect(entry).not.toContain("{{more}}");
    expect(entry).toContain("[true]");

    expect(list).toContain("Before the break");
    expect(list.split("|")[0]).not.toContain("After the break");
    expect(list).not.toContain("{{more}}");
  });

  it("supports the comment form and leaves entries without a marker alone", async function () {
    await this.write({
      path: "/a.txt",
      content: "Link: a\n\nBefore\n\n<!-- more -->\n\nAfter",
    });
    await this.write({ path: "/b.txt", content: "Link: b\n\nNo marker here" });
    await this.template({
      "entry.html": `{{#entry}}{{{html}}}|{{more}}{{/entry}}`,
      "entries.html": `{{#entries}}{{{teaser}}}{{/entries}}`,
    });

    const a = await this.text("/a");
    const b = await this.text("/b");

    expect(a).toContain("Before");
    expect(a).toContain("After");
    expect(a).not.toContain("more -->");
    expect(b).toContain("No marker here");
    expect(b).toContain("|false");
  });
});
