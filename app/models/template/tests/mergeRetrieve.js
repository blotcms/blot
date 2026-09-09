describe("mergeRetrieve", function () {
  var mergeRetrieve = require("../util/mergeRetrieve");

  it("lets a legacy boolean on the target block projection over incoming fields", function () {
    // An un-recalculated view (allEntries: true) whose recalculated partial
    // contributes { fields: { title: true } } must stay a boolean, so
    // projection is skipped and the view's own {{{html}}} still renders.
    expect(
      mergeRetrieve(
        { allEntries: true },
        { allEntries: { fields: { title: true } } }
      )
    ).toEqual({
      allEntries: true,
    });
  });

  it("lets a legacy boolean on the source block projection over existing fields", function () {
    expect(
      mergeRetrieve(
        { allEntries: { fields: { title: true } } },
        { allEntries: true }
      )
    ).toEqual({
      allEntries: true,
    });
  });

  it("merges projected fields from two retrieve objects", function () {
    expect(
      mergeRetrieve(
        { allEntries: { fields: { title: true } } },
        { allEntries: { fields: { url: true } } }
      )
    ).toEqual({
      allEntries: { fields: { title: true, url: true } },
    });
  });

  it("unions cdn arrays", function () {
    expect(mergeRetrieve({ cdn: ["a.css"] }, { cdn: ["b.css"] })).toEqual({
      cdn: ["a.css", "b.css"],
    });
  });

  it("does not let a boolean clobber a non-projection structured value", function () {
    // `plugin` is not projection metadata (no `fields`); a partial's bare
    // {{plugin}} must not wipe out a {{{plugin.katex.css}}} request.
    expect(
      mergeRetrieve(
        { plugin: { katex: { css: true } } },
        { plugin: true }
      )
    ).toEqual({ plugin: { katex: { css: true } } });

    expect(
      mergeRetrieve(
        { plugin: true },
        { plugin: { katex: { css: true } } }
      )
    ).toEqual({ plugin: { katex: { css: true } } });
  });
});
