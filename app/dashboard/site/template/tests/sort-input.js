describe("sort-input (Post sorting control)", function () {
  const sortInput = require("../load/sort-input");
  const SORT_OPTIONS = require("../sort-options");

  function load(locals) {
    const req = { template: { locals } };
    const res = { locals: {} };
    const next = jasmine.createSpy("next");

    sortInput(req, res, next);

    expect(next).toHaveBeenCalledWith();
    return res.locals.post_sorting;
  }

  function selected(control) {
    return control.options.find(option => option.selected === "selected");
  }

  it("builds one select for every template, including empty locals", function () {
    [undefined, {}, { lang: "en" }].forEach(locals => {
      const control = load(locals);
      expect(control.key).toBe("sort_by");
      expect(control.label).toBe("Order");
      expect(control.isSelect).toBe(true);
      expect(control.options.map(o => o.value)).toEqual(
        SORT_OPTIONS.map(o => o.value)
      );
      expect(control.options.filter(o => o.selected === "selected").length).toBe(1);
    });
  });

  it("defaults to newest-first date sorting", function () {
    expect(selected(load({})).value).toBe("date_asc");
  });

  it("selects file-path sorting from flat locals", function () {
    expect(selected(load({ sort_by: "id", sort_order: "asc" })).value).toBe("id_asc");
  });

  it("treats sort_by=id without sort_order as A to Z", function () {
    expect(selected(load({ sort_by: "id" })).value).toBe("id_asc");
  });

  it("prefers nested sort config over flat locals", function () {
    const control = load({
      sort: { by: "id", direction: "desc" },
      sort_by: "date",
      sort_order: "asc"
    });
    expect(selected(control).value).toBe("id_desc");
  });

  it("limits the options to sort_by_options when present", function () {
    const control = load({ sort_by: "id", sort_by_options: ["id"] });
    expect(control.options.map(o => o.value)).toEqual(["id_asc", "id_desc"]);
    expect(selected(control).value).toBe("id_asc");
  });

  it("also honours sort_order_options", function () {
    const control = load({ sort_order_options: ["asc"] });
    expect(control.options.map(o => o.value)).toEqual(["date_asc", "id_asc"]);
  });

  it("combines both allowlists", function () {
    const control = load({
      sort_by: "id",
      sort_by_options: ["id"],
      sort_order_options: ["asc"]
    });
    expect(control.options.map(o => o.value)).toEqual(["id_asc"]);
    expect(selected(control).value).toBe("id_asc");
  });
});
