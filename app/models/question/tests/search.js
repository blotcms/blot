describe("questions.search", function () {
  require("./setup")();

  const create = require("../create");
  const search = require("../search");

  it("returns no results when appropriate", async function () {
    const results = await search({ query: "how" });

    expect(results.length).toBe(0);
  });

  it("returns results", async function () {
    await create({ title: "How", body: "Yes" });
    await create({ title: "Now", body: "Yes" });
    await create({ title: "Brown", body: "Yes" });

    const results = await search({ query: "how" });

    // each result should have only the properties 'title' and 'id'
    results.forEach((result) => {
      expect(Object.keys(result).sort()).toEqual(["id", "score", "title"]);
    });

    expect(results.length).toBe(1);
  });

  it("paginates results", async function () {
    for (let i = 0; i < 15; i++) {
      await create({ title: "How", body: "Yes" });
    }

    const firstPage = await search({ query: "how", page: 1, page_size: 10 });
    const secondPage = await search({ query: "how", page: 2, page_size: 10 });

    expect(firstPage.length).toBe(10);
    expect(secondPage.length).toBe(5);
  });

  it("scores the title higher than the body", async function () {
    await create({ title: "How", body: "Cow" });
    await create({ title: "Now", body: "Cow" });
    const three = await create({ title: "Cow", body: "Yes" });

    const results = await search({ query: "cow" });

    expect(results.length).toBe(3);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBe(results[2].score);
    expect(results[0].id).toBe(three.id);
  });

  it("checks replies", async function () {
    const one = await create({ title: "One", body: "Hello" });
    await create({ body: "Test", parent: one.id });

    const results = await search({ query: "test" });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(one.id);
  });

  it("omits questions with empty bodies", async function () {
    const emptyBody = await create({ title: "How", body: "   " });
    const valid = await create({ title: "How", body: "Yes" });

    const results = await search({ query: "how" });

    const ids = results.map((result) => result.id);
    expect(ids).toContain(valid.id);
    expect(ids).not.toContain(emptyBody.id);
  });

  it("ignores replies with empty bodies", async function () {
    const withoutReplyMatch = await create({ title: "One", body: "Hello" });
    await create({ body: "   ", parent: withoutReplyMatch.id });

    const withReplyMatch = await create({ title: "Two", body: "Hello" });
    await create({ body: "Test reply", parent: withReplyMatch.id });

    const results = await search({ query: "test" });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(withReplyMatch.id);
  });
});
