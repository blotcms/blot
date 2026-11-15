// Each list of posts carries its own pagination ({{#posts.pagination}}), and
// the older forms keep working: the top-level {{#pagination}} and the copy
// on the last entry, which now renders once instead of after every entry.
describe("list pagination", function () {
  require("./util/setup")();

  beforeEach(async function () {
    await this.write({ path: "/a.txt", content: "Tags: x\n\nA" });
    await this.write({ path: "/b.txt", content: "Tags: x\n\nB" });
    await this.write({ path: "/c.txt", content: "Tags: x\n\nC" });
  });

  it("gives posts its own pagination", async function () {
    await this.template(
      {
        "entries.html":
          "{{#posts}}[{{title}}]{{/posts}}" +
          "{{#posts.pagination}}{{current}}/{{total}} next {{next}} of {{total_entries}}{{/posts.pagination}}",
      },
      { locals: { page_size: 2 } }
    );

    const body = await this.text("/");
    expect(body).toContain("1/2 next 2 of 3");
  });

  it("renders the last entry's pagination once", async function () {
    await this.template(
      {
        "entries.html":
          "{{#posts}}[{{title}}]{{#pagination}}<{{next}}>{{/pagination}}{{/posts}}",
      },
      { locals: { page_size: 2 } }
    );

    const body = await this.text("/");
    expect(body.match(/<2>/g).length).toBe(1);
    expect(body.indexOf("<2>")).toBeGreaterThan(body.lastIndexOf("["));
  });

  it("keeps the top-level pagination", async function () {
    await this.template(
      {
        "entries.html":
          "{{#posts}}[{{title}}]{{/posts}}{{#pagination}}<{{next}}>{{/pagination}}",
      },
      { locals: { page_size: 2 } }
    );

    const body = await this.text("/");
    expect(body.match(/<2>/g).length).toBe(1);
  });

  it("keeps entries.pagination on the old entries alias", async function () {
    await this.template(
      {
        "entries.html":
          "{{#entries}}[{{title}}]{{/entries}}{{#entries.pagination}}<{{next}}>{{/entries.pagination}}",
      },
      { locals: { page_size: 2 } }
    );

    const body = await this.text("/");
    expect(body.match(/<2>/g).length).toBe(1);
  });

  it("renders a list's pagination even when the list is empty", async function () {
    await this.template(
      {
        "index.html":
          "{{#posts}}[{{title}}]{{/posts}}{{#posts.pagination}}{{total_entries}} posts{{/posts.pagination}}",
      },
      {
        views: { "index.html": { url: ["/"], locals: { tag: "none" } } },
        locals: { page_size: 2 },
      }
    );

    const body = await this.text("/");
    expect(body).not.toContain("[");
    expect(body).toContain("0 posts");
  });

  it("gives tag-filtered posts the same forms", async function () {
    await this.template(
      {
        "index.html":
          "{{#posts}}[{{title}}]{{#pagination}}<{{next}}>{{/pagination}}{{/posts}}" +
          "{{#posts.pagination}} of {{total_entries}}{{/posts.pagination}}",
      },
      {
        views: { "index.html": { url: ["/"], locals: { tag: "x" } } },
        locals: { page_size: 2 },
      }
    );

    const body = await this.text("/");
    expect(body.match(/<2>/g).length).toBe(1);
    expect(body).toContain(" of 3");
  });

  it("gives tagged entries the same forms on a tag page", async function () {
    await this.template(
      {
        "tagged.html":
          "{{#tagged}}{{#entries}}[{{title}}]{{#pagination}}<{{next}}>{{/pagination}}{{/entries}}" +
          "{{#pagination}} tagged {{total_entries}}{{/pagination}}{{/tagged}}" +
          "{{#entries.pagination}} alias {{total_entries}}{{/entries.pagination}}",
      },
      { locals: { page_size: 2 } }
    );

    const body = await this.text("/tagged/x");
    expect(body.match(/<2>/g).length).toBe(1);
    expect(body).toContain(" tagged 3");
    expect(body).toContain(" alias 3");
  });
});
