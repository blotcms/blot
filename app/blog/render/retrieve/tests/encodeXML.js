describe("encode_xml", function () {
  var encode_xml = require("blog/render/retrieve/encode_xml");
  var mustache = require("mustache");

  global.test.blog();

  beforeEach(function () {
    this.request = {
      protocol: "http",
      get: function () {
        return "example.com";
      },
    };
  });

  it("replaces relative links with absolute URLs", async function () {
    var result;
    var html = '<a href="/foo"></a>';
    var template = "{{#encode_xml}}" + html + "{{/encode_xml}}";

    const lambda = await encode_xml(this.request, {});
    result = mustache.render(template, { encode_xml: lambda });
    expect(result).toEqual('<a href="http://example.com/foo"></a>');
  });

  it("removes invalid characters", async function () {
    var result;
    var html = "& foo &#xFF08;&#x4FBF;&#x5229;";
    var template = "{{#encode_xml}}" + html + "{{/encode_xml}}";

    const lambda = await encode_xml(this.request, {});
    result = mustache.render(template, { encode_xml: lambda });
    expect(result).toEqual("&amp; foo （便利");
  });

  it("removes script tags", async function () {
    var result;
    var html = "<script>alert('foo');</script><p>Hey</p>";
    var template = "{{#encode_xml}}" + html + "{{/encode_xml}}";

    const lambda = await encode_xml(this.request, {});
    result = mustache.render(template, { encode_xml: lambda });
    expect(result).toEqual("<p>Hey</p>");
  });
});
