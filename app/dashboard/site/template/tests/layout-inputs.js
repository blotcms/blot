describe("layout-inputs sort mapping", function () {
  const layoutInputs = require("../save/layout-inputs");

  function save(locals, body) {
    const req = { locals: { ...locals }, body };
    const res = {};
    const next = jasmine.createSpy("next");

    layoutInputs(req, res, next);

    expect(next).toHaveBeenCalledWith();
    return req.locals;
  }

  it("maps a submitted composite select value into sort_by and sort_order", function () {
    const locals = save(
      { page_size: 10, sort_by: "date_asc" },
      { "locals.sort_by": "date_asc" }
    );

    expect(locals.sort_by).toBe("date");
    expect(locals.sort_order).toBe("asc");
  });

  it("maps nested body.locals.sort_by the same way", function () {
    const locals = save(
      { sort_by: "id_desc" },
      { locals: { sort_by: "id_desc" } }
    );

    expect(locals.sort_by).toBe("id");
    expect(locals.sort_order).toBe("desc");
  });

  it("falls back to newest-first date sorting for an invalid submitted value", function () {
    const locals = save({ sort_by: "not-a-sort" }, { "locals.sort_by": "not-a-sort" });

    expect(locals.sort_by).toBe("date");
    expect(locals.sort_order).toBe("asc");
  });

  it("accepts a legacy raw sort_by=id submission, keeping the stored order", function () {
    const locals = save(
      { sort_by: "id", sort_order: "desc", page_size: 8 },
      { "locals.sort_by": "id" }
    );

    expect(locals.sort_by).toBe("id");
    expect(locals.sort_order).toBe("desc");
  });

  it("accepts a legacy raw sort_by=id submission with no stored order", function () {
    const locals = save({ sort_by: "id" }, { "locals.sort_by": "id" });

    expect(locals.sort_by).toBe("id");
    expect(locals.sort_order).toBe("asc");
  });

  it("does not reset existing sort when another layout control is saved", function () {
    const locals = save(
      { sort_by: "id", sort_order: "asc", page_size: 8 },
      { "locals.page_size": "8" }
    );

    expect(locals.sort_by).toBe("id");
    expect(locals.sort_order).toBe("asc");
    expect(locals.page_size).toBe(8);
  });

  it("keeps nested sort in sync when the combined select is submitted", function () {
    const locals = save(
      { sort: { by: "id", direction: "asc" }, sort_by: "date_desc" },
      { "locals.sort_by": "date_desc" }
    );

    expect(locals.sort_by).toBe("date");
    expect(locals.sort_order).toBe("desc");
    expect(locals.sort).toEqual({ by: "date", direction: "desc" });
  });

  it("keeps a nested sort.order alias in sync instead of leaving it stale", function () {
    const locals = save(
      { sort: { by: "id", order: "asc" }, sort_by: "date_desc" },
      { "locals.sort_by": "date_desc" }
    );

    expect(locals.sort_by).toBe("date");
    expect(locals.sort_order).toBe("desc");
    expect(locals.sort).toEqual({ by: "date", order: "desc", direction: "desc" });
  });
});
