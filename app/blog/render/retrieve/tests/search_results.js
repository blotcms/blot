describe("search_results", function () {
  require("blog/tests/util/setup")();

  it("returns matching entries", async function () {
    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });
    await this.write({ path: "/b.txt", content: "Title: Banana\n\nBanana body" });

    await this.template(
      { "search.html": `{{#search_results}}{{title}} {{/search_results}}` },
      { views: { "search.html": { url: "/search" } } }
    );

    const res = await this.get("/search?q=Apple");
    expect((await res.text()).trim()).toEqual("Apple");
  });

  it("lists matching entries when search.html binds only {{#entries}}", async function () {
    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });
    await this.write({ path: "/b.txt", content: "Title: Banana\n\nBanana body" });

    await this.template(
      { "search.html": `{{query}} {{#entries}}{{title}} {{/entries}}` },
      { views: { "search.html": { url: "/search" } } }
    );

    const res = await this.get("/search?q=Apple");
    expect((await res.text()).trim()).toEqual("Apple Apple");
  });

  it("scans once when a view binds both {{#entries}} and {{#search_results}}", async function () {
    const Entry = require("models/entry");
    spyOn(Entry, "search").and.callThrough();

    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    // Both names alias the same search_results retrieve, so a view that
    // binds both must not trigger a second Entry.search scan.
    await this.template(
      {
        "search.html":
          "{{#entries}}{{title}}-e {{/entries}}{{#search_results}}{{title}}-s {{/search_results}}",
      },
      { views: { "search.html": { url: "/search" } } }
    );

    const res = await this.get("/search?q=Apple");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toContain("Apple-e");
    expect(body).toContain("Apple-s");
    expect(Entry.search).toHaveBeenCalledTimes(1);
  });

  it("scans once for a repeated ?q= query", async function () {
    const Entry = require("models/entry");
    spyOn(Entry, "search").and.callThrough();

    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    // Repeated ?q= is joined into one string (req.query.q itself stays
    // an array) so Entry.search is called once with the joined query.
    await this.template(
      {
        "search.html":
          "{{#entries}}{{title}}-e {{/entries}}{{#search_results}}{{title}}-s {{/search_results}}",
      },
      { views: { "search.html": { url: "/search" } } }
    );

    const res = await this.get("/search?q=Apple&q=body");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toContain("Apple-e");
    expect(body).toContain("Apple-s");
    expect(Entry.search).toHaveBeenCalledTimes(1);
  });

  it("drops unreferenced heavy fields from search_results", async function () {
    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    await this.template(
      { "search.html": `{{#search_results}}{{title}} {{url}}{{/search_results}}` },
      { views: { "search.html": { url: "/search" } } }
    );

    const locals = await (await this.get("/search?q=Apple&json=1")).json();

    expect(locals.search_results.length).toEqual(1);
    expect(locals.search_results[0].title).toEqual("Apple");
    expect(locals.search_results[0].url).toBeDefined();
    expect(locals.search_results[0].html).toBeUndefined();
    expect(locals.search_results[0].summary).toBeUndefined();
  });

  it("keeps search_results html when the view renders it", async function () {
    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    await this.template(
      { "search.html": `{{#search_results}}{{{html}}}{{/search_results}}` },
      { views: { "search.html": { url: "/search" } } }
    );

    const locals = await (await this.get("/search?q=Apple&json=1")).json();
    expect(locals.search_results[0].html).toContain("Apple body");
  });
});
