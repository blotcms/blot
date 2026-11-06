describe("random", function () {
  require("./util/setup")();

  it("redirects to a random entry", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.write({ path: "/b.txt", content: "Hello, B!" });
    await this.write({ path: "/c.txt", content: "Hello, C!" });

    const res = await this.get("/random", { redirect: "manual" });

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).toMatch(/\/[abc]/);
    expect(res.headers.get("cache-control")).toEqual("no-cache");
  });

  it("preserves the query string", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.write({ path: "/b.txt", content: "Hello, B!" });
    await this.write({ path: "/c.txt", content: "Hello, C!" });

    const res = await this.get("/random?query=string", { redirect: "manual" });

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).toMatch(/\/[abc]\?query=string/);
  });

  it("if there are no entries, it returns a 404", async function () {
    const res = await this.get("/random", { redirect: "manual" });

    expect(res.status).toEqual(404);
  });
});
