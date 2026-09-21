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
});
