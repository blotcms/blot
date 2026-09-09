describe("latest_entry", function () {
  require("blog/tests/util/setup")();

  it("exposes the most recent entry", async function () {
    await this.write({
      path: "/old.txt",
      content: "Title: Old\nDate: 2020-01-01\n\nOld body",
    });
    await this.write({
      path: "/new.txt",
      content: "Title: New\nDate: 2021-01-01\n\nNew body",
    });

    await this.template(
      { "home.html": `{{#latestEntry}}{{title}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    expect((await (await this.get("/home")).text()).trim()).toEqual("New");
  });

  it("drops unreferenced heavy fields from latestEntry", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "home.html": `{{#latestEntry}}{{title}} {{url}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const locals = await (await this.get("/home?json=1")).json();

    expect(locals.latestEntry.title).toEqual("A");
    expect(locals.latestEntry.url).toBeDefined();
    expect(locals.latestEntry.html).toBeUndefined();
    expect(locals.latestEntry.summary).toBeUndefined();
  });

  it("keeps latestEntry html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "home.html": `{{#latestEntry}}{{{html}}}{{/latestEntry}}` },
      { views: { "home.html": { url: "/home" } } }
    );

    const locals = await (await this.get("/home?json=1")).json();
    expect(locals.latestEntry.html).toContain("A body");
  });
});
