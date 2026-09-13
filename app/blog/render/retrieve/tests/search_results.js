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

  it("scans once when a view binds both {{#entries}} and {{#search_results}}", async function () {
    const Entry = require("models/entry");
    spyOn(Entry, "search").and.callThrough();

    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    // routes/search.js always scans for {{#entries}}; a view that also
    // references {{#search_results}} must not trigger a second
    // Entry.search scan. See
    // https://github.com/davidmerfield/blot/issues/1844
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

  it("reuses the route's scan for a repeated ?q= query", async function () {
    const Entry = require("models/entry");
    spyOn(Entry, "search").and.callThrough();

    await this.write({ path: "/a.txt", content: "Title: Apple\n\nApple body" });

    // routes/search.js joins a repeated ?q= into one string before scanning
    // (req.query.q itself stays an array); search_results.js must join the
    // same way before comparing/falling back, or it never reuses the scan
    // and can pass the raw array to Entry.search. See
    // https://github.com/davidmerfield/blot/issues/1844
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
