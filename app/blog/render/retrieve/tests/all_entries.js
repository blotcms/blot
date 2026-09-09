describe("all_entries", function () {
  require("blog/tests/util/setup")();

  it("renders every entry", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });
    await this.write({ path: "/b.txt", content: "Title: B\n\nB body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}} {{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list");
    expect((await res.text()).trim().split(/\s+/).sort()).toEqual(["A", "B"]);
  });

  it("drops unreferenced heavy fields from allEntries locals", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}} {{url}}{{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries.length).toEqual(1);
    expect(locals.allEntries[0].title).toEqual("A");
    expect(locals.allEntries[0].url).toBeDefined();
    expect(locals.allEntries[0].html).toBeUndefined();
    expect(locals.allEntries[0].body).toBeUndefined();
    expect(locals.allEntries[0].summary).toBeUndefined();
  });

  it("keeps entry html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{{html}}}{{/allEntries}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries[0].html).toContain("A body");
  });

  it("keeps entry body when it is wrapped in an encoder helper", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      {
        "list.html": `{{#allEntries}}{{#encode_xml}}{{{body}}}{{/encode_xml}}{{/allEntries}}`,
      },
      { views: { "list.html": { url: "/list" } } }
    );

    const res = await this.get("/list?json=1");
    const locals = await res.json();

    expect(locals.allEntries[0].body).toContain("A body");

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("A body");
  });

  it("keeps a heavy field referenced only from a template-level local", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}}{{/allEntries}}{{{snippet}}}` },
      {
        views: { "list.html": { url: "/list" } },
        locals: { snippet: "{{#allEntries}}{{{html}}} {{/allEntries}}" },
      }
    );

    const locals = await (await this.get("/list?json=1")).json();
    expect(locals.allEntries[0].html).toContain("A body");

    const rendered = await (await this.get("/list")).text();
    expect(rendered).toContain("A body");
  });

  it("keeps a heavy field referenced only from a query string local", async function () {
    await this.write({ path: "/a.txt", content: "Title: A\n\nA body" });

    await this.template(
      { "list.html": `{{#allEntries}}{{title}}{{/allEntries}}{{{query.snippet}}}` },
      { views: { "list.html": { url: "/list" } } }
    );

    const snippet = encodeURIComponent(
      "{{#allEntries}}{{{html}}} {{/allEntries}}"
    );
    const locals = await (
      await this.get("/list?json=1&snippet=" + snippet)
    ).json();

    expect(locals.allEntries[0].html).toContain("A body");
  });
});
