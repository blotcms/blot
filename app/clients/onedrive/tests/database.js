describe("onedrive database", function () {
  var database = require("../database");

  // Create test blog
  global.test.blog();

  function fakeAccount() {
    return {
      account_id: "XXXXX",
      email: "someone@outlook.com",
      access_token: "YYYYY",
      refresh_token: "ZZZZ",
      expires_at: Date.now() + 3600 * 1000,
      error_code: 0,
    };
  }

  it("sets and gets an account, restoring number types", function (done) {
    var blogID = this.blog.id;
    var account = fakeAccount();

    database.set(blogID, account, function (err) {
      if (err) return done.fail(err);

      database.get(blogID, function (err, stored) {
        if (err) return done.fail(err);
        expect(stored).toEqual(account);
        done();
      });
    });
  });

  it("merges partial changes into the stored account", function (done) {
    var blogID = this.blog.id;

    database.set(blogID, fakeAccount(), function (err) {
      if (err) return done.fail(err);

      database.set(blogID, { error_code: 401 }, function (err) {
        if (err) return done.fail(err);

        database.get(blogID, function (err, stored) {
          if (err) return done.fail(err);
          expect(stored.error_code).toBe(401);
          expect(stored.refresh_token).toBe("ZZZZ");
          done();
        });
      });
    });
  });

  it("drops an account", function (done) {
    var blogID = this.blog.id;

    database.set(blogID, fakeAccount(), function (err) {
      if (err) return done.fail(err);

      database.drop(blogID, function (err) {
        if (err) return done.fail(err);

        database.get(blogID, function (err, stored) {
          if (err) return done.fail(err);
          expect(stored).toBe(null);
          done();
        });
      });
    });
  });
});
