describe("recent tags", function () {
  require("blog/tests/util/setup")();

  it("lists tags with the most recent entry first, each with that entry", async function () {
    await this.write({
      path: "/a.txt",
      content: "Date: 2020-01-01\nTags: old\n\nA",
    });
    await this.write({
      path: "/b.txt",
      content: "Date: 2022-01-01\nTags: new, old\n\nB",
    });
    await this.write({
      path: "/c.txt",
      content: "Date: 2021-01-01\nTags: middle\n\nC",
    });

    await this.template({
      "entries.html": `{{#recent_tags}}[{{tag}} {{total}} {{entry.title}}]{{/recent_tags}}`,
    });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("[new 1 B][old 2 B][middle 1 C]");
  });

  it("respects template locals.path_prefix", async function () {
    await this.write({
      path: "/blog/a.txt",
      content: "Date: 2020-01-01\nTags: abc\n\nA",
    });
    await this.write({
      path: "/notes/b.txt",
      content: "Date: 2022-01-01\nTags: abc, def\n\nB",
    });

    await this.template(
      {
        "entries.html": `{{#recent_tags}}[{{tag}} {{entry.title}}]{{/recent_tags}}`,
      },
      { locals: { path_prefix: "/blog/" } }
    );

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("[abc A]");
  });

  it("gives each tag its newest entries when the view reads them", async function () {
    await this.write({
      path: "/a.txt",
      content: "Date: 2020-01-01\nTags: abc\n\nA",
    });
    await this.write({
      path: "/b.txt",
      content: "Date: 2022-01-01\nTags: abc\n\nB",
    });
    await this.write({
      path: "/c.txt",
      content: "Date: 2021-01-01\nTags: abc\n\nC",
    });

    await this.template({
      "entries.html": `{{#recent_tags}}[{{tag}}:{{#entries}}{{title}}{{/entries}}]{{/recent_tags}}`,
    });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("[abc:BCA]");
  });
});
