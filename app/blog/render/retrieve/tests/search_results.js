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
