describe("transformer", function () {
  // Creates test environment
  require("./setup")({});

  it("flushes its cache of existing transformations", function (done) {
    var test = this;
    var firstTransform = jasmine.createSpy().and.callFake(test.transform);
    var secondTransform = jasmine.createSpy().and.callFake(test.transform);

    test.transformer.lookup(
      test.path,
      firstTransform,
      function (err, firstResult) {
        if (err) return done.fail(err);

        test.transformer.flush().then(function () {
          test.transformer.lookup(
            test.path,
            secondTransform,
            function (err, secondResult) {
              if (err) return done.fail(err);

              expect(firstTransform).toHaveBeenCalled();
              expect(secondTransform).toHaveBeenCalled();
              expect(firstResult).toEqual(secondResult);

              done();
            }
          );
        }, done.fail);
      }
    );
  });
});
