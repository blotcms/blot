describe("mergeRetrieve", function () {
  var mergeRetrieve = require("../util/mergeRetrieve");

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

  it("does not let a boolean clobber a structured value", function () {
    // A partial's bare {{plugin}} must not wipe out another view's
    // {{{plugin.katex.css}}} request when the two are merged.
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
