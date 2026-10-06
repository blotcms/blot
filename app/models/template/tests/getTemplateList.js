describe("list", function () {
  require("./setup")({ createTemplate: true });

  var getTemplateList = require("../index").getTemplateList;

  it("lists all templates", function (done) {
    var test = this;
    getTemplateList(test.blog.id, function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(jasmine.any(Array));
      expect(result).toContain(test.template);
      done();
    });
  });

  it("lists SITE-owned templates for every blog", function (done) {
    var test = this;

    getTemplateList(test.blog.id, function (err, ownerTemplates) {
      if (err) return done.fail(err);

      getTemplateList("another:blog", function (err, otherTemplates) {
        if (err) return done.fail(err);

        var siteTemplateIDs = ownerTemplates
          .filter(function (template) {
            return template.owner === "SITE";
          })
          .map(function (template) {
            return template.id;
          });

        expect(siteTemplateIDs.length).toBeGreaterThan(0);
        siteTemplateIDs.forEach(function (id) {
          expect(
            otherTemplates.some(function (template) {
              return template.id === id;
            })
          ).toBe(true);
        });
        done();
      });
    });
  });

  it("lists blog-owned templates only for their owner", function (done) {
    var test = this;

    getTemplateList("another:blog", function (err, templates) {
      if (err) return done.fail(err);
      expect(
        templates.some(function (template) {
          return template.id === test.template.id;
        })
      ).toBe(false);
      done();
    });
  });

  it("does not return an error if the owner does not exist", function (done) {
    var test = this;
    getTemplateList("nonexistent:blog", function (err, result) {
      if (err) return done.fail(err);
      expect(result).toEqual(jasmine.any(Array));
      done();
    });
  });
});
