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

// next_url and previous_url: root-relative links to the next and previous
// page of the listing, with page 1 at the listing's own URL
describe("pagination URLs", function () {
  require("./util/setup")();

  beforeEach(async function () {
    await this.write({ path: "/a.txt", content: "Tags: x y\n\nA" });
    await this.write({ path: "/b.txt", content: "Tags: x y\n\nB" });
    await this.write({ path: "/c.txt", content: "Tags: x y\n\nC" });
  });

  const URLS =
    "{{#posts}}[{{title}}]{{/posts}}" +
    "{{#posts.pagination}}n={{{next_url}}};p={{{previous_url}}}{{/posts.pagination}}" +
    "|{{#pagination}}n={{{next_url}}};p={{{previous_url}}}{{/pagination}}";

  it("links the index pages, with / for page 1", async function () {
    await this.template({ "entries.html": URLS }, { locals: { page_size: 1 } });

    expect(await this.text("/")).toContain("n=/page/2;p=|n=/page/2;p=");
    expect(await this.text("/page/2")).toContain("n=/page/3;p=/|n=/page/3;p=/");
    expect(await this.text("/page/3")).toContain("n=;p=/page/2|n=;p=/page/2");
  });

  it("links tag pages", async function () {
    await this.template(
      {
        "tagged.html":
          "{{#tagged.pagination}}n={{{next_url}}};p={{{previous_url}}}{{/tagged.pagination}}" +
          "|{{#entries.pagination}}n={{{next_url}}};p={{{previous_url}}}{{/entries.pagination}}",
      },
      { locals: { page_size: 1 } }
    );

    expect(await this.text("/tagged/x/page/2")).toContain(
      "n=/tagged/x/page/3;p=/tagged/x|n=/tagged/x/page/3;p=/tagged/x"
    );
  });

  it("links a view's page pattern, and ?page= for one without", async function () {
    await this.template(
      {
        "archive.html": URLS,
        "list.html": URLS,
      },
      {
        views: {
          "archive.html": { url: ["/archive", "/archive/page/:page"] },
          "list.html": { url: ["/list"] },
        },
        locals: { page_size: 1 },
      }
    );

    expect(await this.text("/archive/page/2")).toContain(
      "n=/archive/page/3;p=/archive|n=/archive/page/3;p=/archive"
    );
    expect(await this.text("/list?page=2&z=1")).toContain(
      "n=/list?page=3&z=1;p=/list?z=1"
    );
  });

  it("pages a tagged list with ?page= on a view without a page pattern", async function () {
    await this.template(
      {
        "tags.html":
          "{{#tagged}}{{#entries}}[{{title}}]{{/entries}}" +
          "{{#pagination}}c={{current}};p={{{previous_url}}}{{/pagination}}{{/tagged}}",
      },
      {
        views: { "tags.html": { url: ["/tags"], locals: { tag: "x" } } },
        locals: { page_size: 1 },
      }
    );

    expect(await this.text("/tags?page=2")).toContain("c=2;p=/tags");
  });
});
