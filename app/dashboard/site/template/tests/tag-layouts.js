const Tags = require("models/tags");
const tagLayouts = require("../load/tag-layouts");

describe("template tag layouts control", function () {
  async function run(locals, tags) {
    spyOn(Tags, "getCachedList").and.returnValue(Promise.resolve(tags));
    const res = { locals: {} };
    await new Promise((resolve, reject) =>
      tagLayouts(
        { template: { locals }, blog: { id: "b", cacheID: 1 } },
        res,
        (err) => (err ? reject(err) : resolve())
      )
    );
    return res.locals.tag_layouts_control;
  }

  const locals = {
    tag_layout: "rows",
    tag_layout_options: ["rows", "grid", "list"],
    tag_layouts: { staff: "list", readings: "list", gallery: "grid" },
  };

  it("lists only the blog's own tags, by name, and keeps the rest unseen", async function () {
    const control = await run(locals, [
      { slug: "readings", name: "Readings" },
      { slug: "gallery", name: "Gallery" },
      { slug: "news", name: "News" },
    ]);
    expect(control.rows.map((row) => row.name)).toEqual([
      "Gallery",
      "Readings",
    ]);
    expect(JSON.parse(control.hidden)).toEqual({ staff: "list" });
    expect(control.tags).toEqual([{ slug: "news", name: "News" }]);
    expect(control.default.label).toEqual("Other tags");
  });

  it("offers the default first in each row", async function () {
    const control = await run(locals, [{ slug: "gallery", name: "Gallery" }]);
    const options = control.rows[0].options;
    expect(options[0]).toEqual({
      value: "",
      label: "Default (Rows)",
      selected: "",
    });
    expect(options.find((o) => o.selected).value).toEqual("grid");
  });

  it("calls the default All tags when no tag has its own", async function () {
    const control = await run(locals, [{ slug: "news", name: "News" }]);
    expect(control.rows).toEqual([]);
    expect(control.default.label).toEqual("All tags");
  });
});
