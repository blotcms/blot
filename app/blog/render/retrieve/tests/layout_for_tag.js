const layoutForTagLocal = require("../layout_for_tag");
const { layoutForTag } = require("../layout_for_tag");

describe("layout_for_tag", function () {
  const locals = {
    tag_layout: "rows",
    tag_layout_options: ["rows", "grid", "events"],
    tag_layouts: { photos: "grid", "caf%C3%A9": "events" },
  };

  it("uses the layout chosen for the tag", async function () {
    const result = await layoutForTagLocal(
      { template: { locals }, params: { tag: "photos" } },
      { locals: {} }
    );
    expect(result).toEqual({ grid: true });
  });

  it("matches a percent-encoded slug against the decoded tag, ignoring case", function () {
    expect(layoutForTag(locals, "Café")).toEqual("events");
    expect(layoutForTag(locals, "PHOTOS")).toEqual("grid");
  });

  it("falls back to the default layout for other tags and pages", function () {
    expect(layoutForTag(locals, "news")).toEqual("rows");
    expect(layoutForTag(locals, undefined)).toEqual("rows");
  });

  it("ignores a layout the template no longer lists", function () {
    expect(
      layoutForTag({ ...locals, tag_layouts: { photos: "masonry" } }, "photos")
    ).toEqual("rows");
  });

  it("uses the first option when the default isn't one of them", function () {
    expect(
      layoutForTag({ tag_layout_options: ["list", "grid"] }, "anything")
    ).toEqual("list");
  });

  it("defaults to rows for a template with no layout settings", async function () {
    const result = await layoutForTagLocal(
      { template: { locals: {} }, params: { tag: "photos" } },
      { locals: {} }
    );
    expect(result).toEqual({ rows: true });
  });
});
