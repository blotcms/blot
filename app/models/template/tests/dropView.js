describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var dropView = require("../index").dropView;
  var getAllViews = require("../index").getAllViews;
  var getMetadata = require("../index").getMetadata;
  var client = require("models/client");

  it("dropView removes a view", function (done) {
    dropView(this.template.id, this.view.name, done);
  });

  it("dropView returns a promise when given no callback", async function () {
    const result = await dropView(this.template.id, this.view.name);

    expect(result).toEqual("Deleted " + this.template.id);
    await expectAsync(
      dropView(this.template.id, this.view.name)
    ).toBeRejected();
  });

  it("dropView gives the template a new cache ID", function (done) {
    var test = this;
    getMetadata(test.template.id, function (err, before) {
      if (err) return done.fail(err);
      dropView(test.template.id, test.view.name, function (err) {
        if (err) return done.fail(err);
        getMetadata(test.template.id, function (err, after) {
          if (err) return done.fail(err);
          expect(after.cacheID).toEqual(jasmine.any(String));
          expect(after.cacheID).not.toEqual(before.cacheID);
          done();
        });
      });
    });
  });

  it("dropView removes a view from the list of views", function (done) {
    var test = this;
    getAllViews(test.template.id)
      .then(function ({ views }) {
        expect(views[test.view.name].content).toEqual(test.view.content);
        dropView(test.template.id, test.view.name, function (dropErr) {
          if (dropErr) return done.fail(dropErr);
          getAllViews(test.template.id)
            .then(function ({ views: allViews }) {
              expect(allViews).toEqual({});
              done();
            })
            .catch(done.fail);
        });
      })
      .catch(done.fail);
  });

  function expectKeyDeleted(searchPattern, templateID, viewName, done) {
    client
      .keys(searchPattern)
      .then(function (result) {
        expect(result.length).toEqual(1);
        dropView(templateID, viewName, function (err) {
          if (err) return done.fail(err);

          client
            .keys(searchPattern)
            .then(function (after) {
              expect(after).toEqual([]);
              done();
            })
            .catch(done.fail);
        });
      })
      .catch(done.fail);
  }

  it("dropView removes the key for the view", function (done) {
    var test = this;
    expectKeyDeleted(
      "template:" + test.template.id + ":view:*",
      test.template.id,
      test.view.name,
      done
    );
  });

  it("dropView removes the URL key for the view", function (done) {
    var test = this;
    expectKeyDeleted(
      "template:" + test.template.id + ":url:*",
      test.template.id,
      test.view.name,
      done
    );
  });

  it("dropView removes the URL patterns key for the view", function (done) {
    var test = this;
    expectKeyDeleted(
      "template:" + test.template.id + ":url_patterns",
      test.template.id,
      test.view.name,
      done
    );
  });

  it("dropView returns an error when the template does not exist", function (done) {
    var test = this;
    dropView("nonexistent:template", test.view.name, function (err) {
      expect(err instanceof Error).toBe(true);
      expect(err.code).toEqual("ENOENT");
      done();
    });
  });
});
