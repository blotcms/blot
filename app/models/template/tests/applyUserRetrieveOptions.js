describe("applyUserRetrieveOptions", function () {
  var applyUserRetrieveOptions = require("../util/applyUserRetrieveOptions");

  it("returns the parser output when nothing else is supplied", function () {
    expect(
      applyUserRetrieveOptions(
        { posts: { fields: { title: true } } },
        undefined,
        {}
      )
    ).toEqual({ posts: { fields: { title: true } } });
  });

  it("does not mutate the parser output it was given", function () {
    var parsed = { posts: { fields: { title: true } } };
    applyUserRetrieveOptions(parsed, undefined, { includeDraft: true });
    expect(parsed).toEqual({ posts: { fields: { title: true } } });
  });

  it("carries over a real retrieve local the parser could not see", function () {
    // e.g. locals.snippet = "{{latest_entry.title}}", content = "{{{snippet}}}"
    expect(
      applyUserRetrieveOptions({}, undefined, { latest_entry: true })
    ).toEqual({ latest_entry: true });
  });

  it("drops non-system keys from the stored retrieve", function () {
    expect(
      applyUserRetrieveOptions({}, { foo: true }, { bar: 1, months: true })
    ).toEqual({});
  });

  it("keeps includeDraft / filters, with the request winning over the stored value", function () {
    expect(
      applyUserRetrieveOptions(
        { posts: { fields: { title: true } } },
        { includeDraft: true },
        { includeDraft: false, filters: [{ tag: "x" }] }
      )
    ).toEqual({
      posts: { fields: { title: true } },
      includeDraft: true,
      filters: [{ tag: "x" }],
    });
  });

  it("lets the parser's projection object win over a stored bare boolean", function () {
    expect(
      applyUserRetrieveOptions(
        { allEntries: { fields: { html: true } } },
        undefined,
        { allEntries: true }
      )
    ).toEqual({ allEntries: { fields: { html: true } } });
  });

  it("unions and sorts cdn targets from the stored retrieve", function () {
    expect(
      applyUserRetrieveOptions({ cdn: ["b.js"] }, undefined, {
        cdn: ["a.js", "b.js"],
      })
    ).toEqual({ cdn: ["a.js", "b.js"] });
  });

  it("is idempotent: re-applying its own output changes nothing", function () {
    var parseTemplate = require("../parseTemplate");
    var content =
      "{{{appCSS}}}{{#posts}}{{title}}{{{html}}}{{/posts}}" +
      "{{#latest_entry}}{{summary}}{{/latest_entry}}";

    var first = applyUserRetrieveOptions(
      parseTemplate(content).retrieve || {},
      undefined,
      {}
    );
    var second = applyUserRetrieveOptions(
      parseTemplate(content).retrieve || {},
      undefined,
      first
    );

    expect(second).toEqual(first);
  });
});
