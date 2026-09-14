describe("favicon template support", function () {
  const { templateSupportsFavicon } = require("../load/favicon");

  it("requires a favicon local in the template or one of its views", function () {
    expect(templateSupportsFavicon({ locals: {} }, {})).toBe(false);
    expect(
      templateSupportsFavicon(
        { locals: {} },
        { head: { retrieve: { favicon: true } } }
      )
    ).toBe(true);
  });

  it("recognises favicon nested in an entry object", function () {
    expect(
      templateSupportsFavicon(
        { locals: {} },
        { entry: { retrieve: { entry: { favicon: true } } } }
      )
    ).toBe(true);
  });

  it("recognises an existing favicon local even without view metadata", function () {
    expect(
      templateSupportsFavicon({ locals: { favicon: {} } }, {})
    ).toBe(true);
  });
});
