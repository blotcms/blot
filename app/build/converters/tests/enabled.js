describe("build/converters/enabled", function () {
  var converters = require("../index");
  var enabledConverters = require("../enabled");

  it("ensures all converters expose stable ids", function () {
    var ids = converters.map(function (converter) {
      return converter.id;
    });

    ids.forEach(function (id) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns all converters when blog preferences are missing", function () {
    var enabled = enabledConverters({ id: "blog" });

    expect(enabled.length).toBe(converters.length);
  });

  it("filters disabled converters", function () {
    var enabled = enabledConverters({
      id: "blog",
      converters: {
        img: false,
      },
    });

    var ids = enabled.map(function (converter) {
      return converter.id;
    });

    expect(ids).not.toContain("img");
  });

  it("normalizes non-boolean preferences before filtering", function () {
    var enabled = enabledConverters({
      id: "blog",
      converters: {
        img: "off",
      },
    });

    var ids = enabled.map(function (converter) {
      return converter.id;
    });

    expect(ids).not.toContain("img");
  });

  it("treats disabled image files as wrong type", function () {
    var enabled = enabledConverters({
      id: "blog",
      converters: {
        img: false,
      },
    });

    var canConvertImage = enabled.some(function (converter) {
      return converter.is("/photo.jpg");
    });

    expect(canConvertImage).toBe(false);
  });
});
