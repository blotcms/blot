var format = require("../format");

describe("entry/format", function () {
  it("round-trips every model type through serialize/deserialize", function () {
    var entry = {
      id: "/post.txt",
      title: "Hello",
      body: "",
      size: 1234,
      dateStamp: 1600000000000,
      menu: false,
      page: true,
      tags: ["a", "b"],
      dependencies: [],
      metadata: { foo: "bar" },
      exif: {},
    };

    var restored = format.deserialize(format.serialize(entry));

    expect(restored).toEqual(entry);
  });

  it("coerces string field values back to their model types", function () {
    var restored = format.deserialize({
      title: "Plain",
      size: "42",
      menu: "true",
      page: "false",
      tags: '["x"]',
      metadata: '{"k":1}',
    });

    expect(restored.title).toBe("Plain");
    expect(restored.size).toBe(42);
    expect(restored.menu).toBe(true);
    expect(restored.page).toBe(false);
    expect(restored.tags).toEqual(["x"]);
    expect(restored.metadata).toEqual({ k: 1 });
  });

  it("omits fields that are absent from the hash", function () {
    var restored = format.deserialize({ title: "Only title" });

    expect(restored).toEqual({ title: "Only title" });
    expect("html" in restored).toBe(false);
  });

  it("falls back to empty containers for corrupt JSON", function () {
    var restored = format.deserialize({ tags: "not json", metadata: "{" });

    expect(restored.tags).toEqual([]);
    expect(restored.metadata).toEqual({});
  });

  it("drops NaN numbers rather than storing them", function () {
    var restored = format.deserialize({ size: "abc" });

    expect("size" in restored).toBe(false);
  });

  it("serialize turns booleans, numbers and objects into strings", function () {
    var serialized = format.serialize({
      title: "t",
      menu: true,
      size: 5,
      tags: ["a"],
    });

    expect(serialized).toEqual({
      title: "t",
      menu: "true",
      size: "5",
      tags: '["a"]',
    });
  });
});
