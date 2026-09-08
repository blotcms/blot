describe("index-inputs", function () {
  const indexInputs = require("../load/index-inputs");

  function load(locals) {
    const req = { template: { locals } };
    const res = { locals: {} };
    const next = jasmine.createSpy("next");

    indexInputs(req, res, next);

    expect(next).toHaveBeenCalledWith();
    return res.locals.index_page;
  }

  it("builds layout inputs from recognised keys", function () {
    const inputs = load({ page_size: 10 });
    expect(inputs.some(input => input.key === "page_size")).toBe(true);
  });

  it("never renders sorting keys (they belong to the Post sorting control)", function () {
    const inputs = load({
      page_size: 12,
      sort: { by: "id" },
      sort_by: "id",
      sort_by_options: ["id", "date"],
      sort_order: "asc",
      sort_order_options: ["asc", "desc"]
    });

    ["sort", "sort_by", "sort_order"].forEach(key => {
      expect(inputs.some(input => input.key === key)).toBe(false);
    });
  });

  it("returns an empty list for templates with no layout keys", function () {
    expect(load({})).toEqual([]);
    expect(load({ lang: "en", background_color: "#fff" })).toEqual([]);
  });
});
