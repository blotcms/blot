describe("archives", function () {
  require("blog/tests/util/setup")();

  it("groups entries by year and month", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });
    await this.write({
      path: "/b.txt",
      content: "Title: B\nDate: 2021-03-04\n\nB body",
    });

    await this.template(
      {
        "arch.html": `{{#archives}}{{year}}:{{#months}}{{month}}({{#entries}}{{title}} {{/entries}}){{/months}} {{/archives}}`,
      },
      { views: { "arch.html": { url: "/arch" } } }
    );

    const text = (await (await this.get("/arch")).text()).trim();
    expect(text).toContain("2021:March(B )");
    expect(text).toContain("2020:January(A )");
  });

  it("drops unreferenced heavy fields from archives entries", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nDate: 2020-01-02\n\nA body",
    });

    await this.template(
      {
        "arch.html": `{{#archives}}{{#months}}{{#entries}}{{title}}{{/entries}}{{/months}}{{/archives}}`,
      },
      { views: { "arch.html": { url: "/arch" } } }
    );

    const locals = await (await this.get("/arch?json=1")).json();
    const entry = locals.archives[0].months[0].entries[0];

    expect(entry.title).toEqual("A");
    expect(entry.html).toBeUndefined();
    expect(entry.summary).toBeUndefined();
  });
});
