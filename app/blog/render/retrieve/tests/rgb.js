describe("rgb", function () {
  var rgb = require("blog/render/retrieve/rgb");
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

  it("turns hex colors into an rgb string", function (done) {
    var result;
    var template = "{{#rgb}}#000{{/rgb}}";

    rgb(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { rgb: lambda });
      expect(result).toEqual("0, 0, 0");
      done();
    });
  });

  it("turns rgba colors into an rgb string", function (done) {
    var result;
    var template = "{{#rgb}}rgba(2,3,4,0.5){{/rgb}}";

    rgb(this.request, {}, function (err, lambda) {
      result = mustache.render(template, { rgb: lambda });
      expect(result).toEqual("2, 3, 4");
      done();
    });
  });
});
