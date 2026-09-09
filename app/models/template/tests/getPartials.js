describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var getPartials = require("../index").getPartials;
  var setView = require("../index").setView;

  it("gets a partials for a view", function (done) {
    var test = this;
    var partials = {};

    partials[test.view.name] = "";

    getPartials(test.blog.id, test.template.id, partials, function (
      err,
      partials,
      retrieve
    ) {
      if (err) return done.fail(err);
      expect(partials[test.view.name]).toEqual(test.view.content);
      done();
    });
  });

  // If you have a template view 'header.html' which embeds
  // the partial view 'nav.html', when you get the partials
  // for header.html, you should recieve nav.html too.
  it("retrieves partial used in a partial", function (done) {
    var test = this;

    // We create a second view which embeds the view
    // already created for this spec. When we call
    // Template.getPartials for the second view, we
    // expect to receive both the second view's contents
    // and the contents of the view already created.
    var parentView = {
      name: "parent.html",
      content: "{{> " + test.view.name + "}}",
    };

    var partials = {};

    partials[parentView.name] = "";

    setView(test.template.id, parentView, function (err) {
      if (err) return done.fail(err);
      getPartials(test.blog.id, test.template.id, partials, function (
        err,
        partials,
        retrieve
      ) {
        if (err) return done.fail(err);
        expect(partials[test.view.name]).toEqual(test.view.content);
        expect(partials[parentView.name]).toEqual(parentView.content);

        done();
      });
    });
  });

  it("resolves file-backed partial paths case-insensitively", async function () {
    await this.set("/Pages/Home.txt", "Hello from home");

    await new Promise((resolve, reject) => {
      getPartials(
        this.blog.id,
        this.template.id,
        { "/pages/home.txt": null },
        function (err, partials) {
          if (err) return reject(err);
          expect(partials["/pages/home.txt"]).toContain("Hello from home");
          expect(partials["/Pages/Home.txt"]).toBeUndefined();
          resolve();
        }
      );
    });
  });
});
