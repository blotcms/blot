describe("absolute_urls", function () {
  var absolute_urls = require("blog/render/retrieve/absolute_urls");
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

  it("replaces relative links with absolute URLs", function (done) {
    var result;
    var html = '<a href="/foo"></a>';
    var template = "{{#absolute_urls}}" + html + "{{/absolute_urls}}";

    absolute_urls(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { absolute_urls: lambda });
      expect(result).toEqual('<a href="http://example.com/foo"></a>');
      done();
    });
  });

  it("replaces relative image sources with absolute sources", function (done) {
    var result;
    var html = '<img src="/bar.jpg">';
    var template = "{{#absolute_urls}}" + html + "{{/absolute_urls}}";

    absolute_urls(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { absolute_urls: lambda });
      expect(result).toEqual('<img src="http://example.com/bar.jpg">');
      done();
    });
  });

  it("leaves fully qualified links and images as-is", function (done) {
    var result;
    var html =
      '<a href="http://example.com/foo"><img src="http://example.com/bar.jpg"></a>';
    var template = "{{#absolute_urls}}" + html + "{{/absolute_urls}}";

    absolute_urls(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { absolute_urls: lambda });
      expect(result).toEqual(html);
      done();
    });
  });
});
