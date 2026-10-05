describe("referencedIdentifiers", function () {
  var referencedIdentifiers = require("../util/referencedIdentifiers");

  it("finds names in sections, variables and dotted paths", function () {
    var referenced = referencedIdentifiers(
      "{{#a.b}}{{{c}}}{{/a.b}}{{^d}}{{&e}}{{/d}}",
      {}
    );
    ["a", "b", "c", "d", "e"].forEach(function (name) {
      expect(referenced.has(name)).toBe(true);
    });
    expect(referenced.has("f")).toBe(false);
  });

  it("finds names that only a partial mentions", function () {
    var referenced = referencedIdentifiers("{{> item}}", {
      item: "{{#backlinks}}{{title}}{{/backlinks}}",
    });
    expect(referenced.has("backlinks")).toBe(true);
  });

  it("does not match a name only found as text or inside a longer name", function () {
    var referenced = referencedIdentifiers("backlinks {{my_backlinks}}", {});
    expect(referenced.has("backlinks")).toBe(false);
  });

  it("treats every name as referenced when a fragment does not parse", function () {
    var referenced = referencedIdentifiers("{{title}}", { broken: "{{#open}}" });
    expect(referenced.has("backlinks")).toBe(true);
  });
});
