describe("system retrieve locals", function () {
  var parseTemplate = require("models/template/parseTemplate");
  var dictionary = require("blog/render/retrieve").dictionary;

  it("recognises every name blot can actually fetch", function () {
    var missing = Object.keys(dictionary).filter(function (name) {
      return !parseTemplate.isSystemRetrieveLocal(name);
    });

    // If this fails, a retrieve dictionary alias was added without teaching
    // parseTemplate.isSystemRetrieveLocal about it (retrieveAliases).
    expect(missing).toEqual([]);
  });
});
