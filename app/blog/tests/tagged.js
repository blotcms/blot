const Entries = require("models/entries");
const retrieveTagged = require("../render/retrieve/tagged");

describe("tags work on sites", function () {
  require("./util/setup")();

  it("lists entries in reverse chronological", async function () {
    await this.publish({ path: "/first.txt", content: "Tags: A\n\nFoo" });
    await this.publish({ path: "/second.txt", content: "Tags: A,B\n\nBar" });
    await this.publish({ path: "/third.txt", content: "Tags: B,C\n\nBaz" });

    await this.template({
      "tagged.html": "{{#entries}}{{title}} {{/entries}}",
    });

    const body = await this.text(`/tagged/a`);

    expect(body.trim().toLowerCase()).toEqual("second first");
  });

  it("renders overlapping tag feeds independently", async function () {
    await this.publish({ path: "/first.txt", content: "Tags: A\n\nFoo" });
    await this.publish({ path: "/second.txt", content: "Tags: A,B\n\nBar" });
    await this.publish({ path: "/third.txt", content: "Tags: B\n\nBaz" });

    await this.template({
      "tagged.html": "{{#entries}}{{title}}\n{{/entries}}",
    });

    const getTitles = async (slug) => {
      const res = await this.get(`/tagged/${slug}`);
      expect(res.status).toBe(200);
      const body = (await res.text()).trim();
      return body ? body.split(/\n+/).map((title) => title.toLowerCase()) : [];
    };

    await expectAsync(getTitles("a")).toBeResolvedTo(["second", "first"]);
    await expectAsync(getTitles("b")).toBeResolvedTo(["third", "second"]);
  });

  it("fetches intersected entry IDs for multiple tags", async function () {
    await this.publish({ path: "/first.txt", content: "Tags: Alpha\n\nOne" });
    await this.publish({
      path: "/second.txt",
      content: "Tags: Alpha,Beta\n\nTwo",
    });
    await this.publish({
      path: "/third.txt",
      content: "Tags: Beta\n\nThree",
    });

    const result = await retrieveTagged(
      {
        blog: this.blog,
        query: { tag: ["alpha", "beta"] },
        params: {},
        template: {},
      },
      { locals: {} }
    );

    expect(result.entryIDs).toEqual(["/second.txt"]);
    expect(result.tag).toBe("Alpha + Beta");
    expect(result.tagged["Alpha + Beta"]).toBe(true);
    expect(result.tagged["alpha + beta"]).toBe(true);
  });

  it("lets you filter entries with a specific tag", async function () {
    await this.publish({ path: "/first.txt", content: "Tags: A\n\nFoo" });
    await this.publish({ path: "/second.txt", content: "Tags: A,B\n\nBar" });
    await this.publish({ path: "/third.txt", content: "Tags: B,C\n\nBaz" });

    await this.template(
      {
        "index.html": "{{#tagged}}{{#entries}}{{title}}{{/entries}}{{/tagged}}",
      },
      {
        views: {
          "index.html": {
            url: ["/", "/page/:page"],
            locals: { tag: "b" },
          },
        },
        locals: { page_size: 1 },
      }
    );

    expect(await this.text(`/`)).toEqual("third");
    expect(await this.text(`/page/2`)).toEqual("second");
  });

  it("excludes entries without tags from tagged feeds", async function () {
    await this.publish({
      path: "/untagged.txt",
      content: "Title: Untagged\n\nJust content",
    });
    await this.publish({
      path: "/with-tag.txt",
      content: "Title: With Tag\nTags: Solo\n\nHas a tag",
    });

    await this.template({
      "tagged.html": "{{#entries}}{{title}}\n{{/entries}}",
    });

    const res = await this.get(`/tagged/solo`);
    const titles = (await res.text()).trim().split(/\n+/).filter(Boolean);

    expect(res.status).toBe(200);
    expect(titles.map((title) => title.toLowerCase())).toEqual(["with tag"]);
  });

  it("normalizes multi-word tag slugs and preserves pretty casing", async function () {
    await this.publish({
      path: "/first-multi.txt",
      content: "Title: First Multi\nTags: Multi Word\n\nBody",
    });
    await this.publish({
      path: "/second-multi.txt",
      content: "Title: Second Multi\nTags: Multi Word\n\nBody",
    });

    await this.template({
      "tagged.html": "{{tag}}\n{{#entries}}{{title}}\n{{/entries}}",
    });

    const res = await this.get(`/tagged/multi%20word`);
    const lines = (await res.text()).trim().split(/\n+/).filter(Boolean);

    expect(res.status).toBe(200);
    expect(lines[0]).toBe("Multi Word");
    expect(lines.slice(1).map((title) => title.toLowerCase())).toEqual([
      "second multi",
      "first multi",
    ]);
  });

  it("matches tags case-insensitively while keeping pretty names", async function () {
    await this.publish({
      path: "/mixed.txt",
      content: "Title: Mixed One\nTags: MixedCase\n\nFirst",
    });
    await this.publish({
      path: "/mixed-two.txt",
      content: "Title: Mixed Two\nTags: MixedCase\n\nSecond",
    });

    await this.template({
      "tagged.html": "{{tag}}\n{{#entries}}{{title}}\n{{/entries}}",
    });

    const lower = await this.get(`/tagged/mixedcase`);
    const upper = await this.get(`/tagged/MIXEDCASE`);

    const parse = async (res) => {
      const lines = (await res.text()).trim().split(/\n+/).filter(Boolean);
      return {
        tag: lines[0],
        titles: lines.slice(1).map((title) => title.toLowerCase()),
      };
    };

    const lowerParsed = await parse(lower);
    const upperParsed = await parse(upper);

    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    expect(lowerParsed.tag).toBe("MixedCase");
    expect(upperParsed).toEqual(lowerParsed);
    expect(lowerParsed.titles).toEqual(["mixed two", "mixed one"]);
  });

  it("returns an empty list for unknown tags", async function () {
    await this.template({
      "tagged.html": "Total: {{total}}\n{{#entries}}{{title}}\n{{/entries}}",
    });

    const res = await this.get(`/tagged/does-not-exist`);
    const lines = (await res.text()).trim().split(/\n+/).filter(Boolean);

    expect(res.status).toBe(200);
    expect(lines[0]).toBe("Total: 0");
    expect(lines.length).toBe(1);
  });

  it("ignores improperly encoded tag slugs", async function () {
    await this.publish({
      path: "/encoded.txt",
      content: "Title: Encoded\nTags: Multi Word\n\nBody",
    });

    await this.template({
      "tagged.html": "Total: {{total}}\n{{#entries}}{{title}}\n{{/entries}}",
    });

    const res = await this.get(`/tagged/multi%2520word`);
    const lines = (await res.text()).trim().split(/\n+/).filter(Boolean);

    expect(res.status).toBe(200);
    expect(lines[0]).toBe("Total: 0");
    expect(lines.length).toBe(1);
  });

  it("keeps entries retrieval stable when tags change", async function () {
    const fetchEntryIDs = async () => {
      const lists = await Entries.get(this.blog.id, {
        lists: ["entries"],
        skinny: true,
      });
      return lists.entries.map((entry) => entry.id);
    };

    await this.publish({
      path: "/flux.txt",
      content: "Title: Flux\nTags: Start\n\nInitial",
    });

    await this.template({
      "tagged.html": "{{#entries}}{{title}}\n{{/entries}}",
    });

    const initialIDs = await fetchEntryIDs();
    const tagged = await this.get(`/tagged/start`);
    expect(initialIDs).toEqual(["/flux.txt"]);
    expect((await tagged.text()).trim().toLowerCase()).toBe("flux");

    await this.publish({
      path: "/flux.txt",
      content: "Title: Flux\n\nUpdated",
    });

    const afterRemovalIDs = await fetchEntryIDs();
    const removed = await this.get(`/tagged/start`);
    expect(afterRemovalIDs).toEqual(initialIDs);
    expect((await removed.text()).trim()).toBe("");

    await this.publish({
      path: "/flux.txt",
      content: "Title: Flux\nTags: Start,Again\n\nReapplied",
    });

    const afterReapplyIDs = await fetchEntryIDs();
    const restored = await this.get(`/tagged/start`);
    expect(afterReapplyIDs).toEqual(initialIDs);
    expect((await restored.text()).trim().toLowerCase()).toBe("flux");
  });

  it("exposes pagination metadata for tagged routes", async function () {
    await this.publish({
      path: "/page-one.txt",
      content: "Title: Page One\nTags: Paginated\n\nFirst",
    });
    await this.publish({
      path: "/page-two.txt",
      content: "Title: Page Two\nTags: Paginated\n\nSecond",
    });
    await this.publish({
      path: "/page-three.txt",
      content: "Title: Page Three\nTags: Paginated\n\nThird",
    });

    await this.template(
      {
        "tagged.html": `
        {
            "current": {{pagination.current}},
            "total": {{pagination.total}},
            "previous": "{{pagination.previous}}",
            "next": "{{pagination.next}}",
            "entries": [
                {{#entries}}
                    "{{title}}"{{^last}},{{/last}}
                {{/entries}}
            ]
        }`,
      },
      { locals: { page_size: 2 } }
    );

    const res = await this.get(`/tagged/paginated`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = JSON.parse(text);

    expect(parsed).toEqual(
      jasmine.objectContaining({
        current: 1,
        total: 2,
        previous: "",
        next: "2",
      })
    );
    expect(parsed.entries.map((title) => title.toLowerCase())).toEqual([
      "page three",
      "page two",
    ]);

    // fetch page 2
    const resPage2 = await this.get(`/tagged/paginated/page/2`);
    expect(resPage2.status).toBe(200);
    const textPage2 = await resPage2.text();
    const parsedPage2 = JSON.parse(textPage2);

    expect(parsedPage2).toEqual(
      jasmine.objectContaining({
        current: 2,
        total: 2,
        previous: "1",
        next: "",
      })
    );
    expect(parsedPage2.entries.map((title) => title.toLowerCase())).toEqual([
      "page one",
    ]);

    // fetch page beyond total pages
    const resPage3 = await this.get(`/tagged/paginated/page/3`);
    expect(resPage3.status).toBe(200);
    const textPage3 = await resPage3.text();
    const parsedPage3 = JSON.parse(textPage3);

    expect(parsedPage3).toEqual(
      jasmine.objectContaining({
        current: 3,
        total: 2,
        previous: "2",
        next: "",
      })
    );
    expect(parsedPage3.entries).toEqual([]);
  });

  it("prefers tagged_page_size over default template page size", async function () {
    await this.publish({
      path: "/tag-one.txt",
      content: "Title: Tag One\nTags: Special\n\nFirst",
    });
    await this.publish({
      path: "/tag-two.txt",
      content: "Title: Tag Two\nTags: Special\n\nSecond",
    });
    await this.publish({
      path: "/tag-three.txt",
      content: "Title: Tag Three\nTags: Special\n\nThird",
    });

    await this.template(
      {
        "entries.html": "{{#entries}}{{title}}\n{{/entries}}",
        "tagged.html":
          "page_size={{pagination.page_size}};current={{pagination.current}};entries={{#entries}}{{title}}|{{/entries}}",
      },
      { locals: { page_size: 1, tagged_page_size: 2 } }
    );

    const indexRes = await this.get(`/`);
    expect(indexRes.status).toBe(200);
    const indexTitles = (await indexRes.text())
      .trim()
      .split(/\n+/)
      .filter(Boolean);
    expect(indexTitles.length).toBe(1);

    const res = await this.get(`/tagged/special`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const [pageSizeSnakePart, currentPart, entriesPart] = body.split(";");
    expect(pageSizeSnakePart).toBe("page_size=2");
    expect(currentPart).toBe("current=1");
    const entries = entriesPart
      .replace(/^entries=/, "")
      .split("|")
      .filter(Boolean)
      .map((title) => title.toLowerCase());

    expect(entries).toEqual(["tag three", "tag two"]);

    const resPage2 = await this.get(`/tagged/special/page/2`);
    expect(resPage2.status).toBe(200);
    const bodyPage2 = await resPage2.text();
    const [pageSizeSnakePart2, currentPart2, entriesPart2] =
      bodyPage2.split(";");

    expect(pageSizeSnakePart2).toBe("page_size=2");
    expect(currentPart2).toBe("current=2");
    const entriesPage2 = entriesPart2
      .replace(/^entries=/, "")
      .split("|")
      .filter(Boolean)
      .map((title) => title.toLowerCase());

    expect(entriesPage2).toEqual(["tag one"]);
  });

  it("falls back to the default template page size when tagged_page_size is absent", async function () {
    await this.publish({
      path: "/fallback-one.txt",
      content: "Title: Fallback One\nTags: Alt\n\nFirst",
    });
    await this.publish({
      path: "/fallback-two.txt",
      content: "Title: Fallback Two\nTags: Alt\n\nSecond",
    });
    await this.publish({
      path: "/fallback-three.txt",
      content: "Title: Fallback Three\nTags: Alt\n\nThird",
    });
    await this.publish({
      path: "/fallback-four.txt",
      content: "Title: Fallback Four\nTags: Alt\n\nFourth",
    });

    await this.template(
      {
        "tagged.html":
          "page_size={{pagination.page_size}};current={{pagination.current}};entries={{#entries}}{{title}}|{{/entries}}",
      },
      { locals: { page_size: 3 } }
    );

    const res = await this.get(`/tagged/alt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const [pageSizeSnakePart, currentPart, entriesPart] = body.split(";");

    expect(pageSizeSnakePart).toBe("page_size=3");
    expect(currentPart).toBe("current=1");
    const entries = entriesPart
      .replace(/^entries=/, "")
      .split("|")
      .filter(Boolean)
      .map((title) => title.toLowerCase());

    expect(entries).toEqual([
      "fallback four",
      "fallback three",
      "fallback two",
    ]);

    const resPage2 = await this.get(`/tagged/alt/page/2`);
    expect(resPage2.status).toBe(200);
    const bodyPage2 = await resPage2.text();
    const [pageSizeSnakePart2, currentPart2, entriesPart2] =
      bodyPage2.split(";");
    expect(pageSizeSnakePart2).toBe("page_size=3");
    expect(currentPart2).toBe("current=2");
    const entriesPage2 = entriesPart2
      .replace(/^entries=/, "")
      .split("|")
      .filter(Boolean)
      .map((title) => title.toLowerCase());
    expect(entriesPage2).toEqual(["fallback one"]);
  });

  it("encodes the tagged route slug local", async function () {
    await this.publish({
      path: "/slash-tag-route.txt",
      content: "Title: Slash\nTags: Design/UI\n\nBody",
    });

    await this.template({
      "tagged.html": "slug={{slug}};tag={{{tag}}}",
    });

    const res = await this.getWithRawPath("/tagged/design%2Fui");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("slug=design%2Fui;tag=Design/UI");
  });

  it("reports total count when pagination options are provided", async function () {
    await this.publish({
      path: "/page-a.txt",
      content: "Title: Page A\nTags: Counted\n\nFirst",
    });
    await this.publish({
      path: "/page-b.txt",
      content: "Title: Page B\nTags: Counted\n\nSecond",
    });

    const result = await retrieveTagged(
      {
        blog: this.blog,
        query: { tag: "counted" },
        params: { tag: "counted", page: "1" },
        template: { locals: { page_size: 1 } },
      },
      { locals: {} }
    );

    expect(result.total).toBe(2);
    expect(result.entryIDs.length).toBe(1);
    expect(result.tag).toBe("Counted");
    expect(result.pagination).toEqual(
      jasmine.objectContaining({
        current: 1,
        page_size: 1,
        total: 2,
        total_entries: 2,
        previous: null,
        next: 2,
      })
    );
  });
});
