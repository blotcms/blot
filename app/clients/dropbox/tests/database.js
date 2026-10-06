describe("dropbox database", function () {
  var database = require("../database");

  // Create test blog
  global.test.blog();

  describe("sets", function () {
    it("a valid account", function (done) {
      database.set(this.blog.id, fakeAccount(), done);
    });
  });

  describe("gets", function () {
    beforeEach(function (done) {
      database.set(this.blog.id, fakeAccount(), done);
    });

    it("a valid account", function (done) {
      database.get(this.blog.id, function (err, account) {
        if (err) return done.fail(err);
        done();
      });
    });
  });

  describe("drops", function () {
    beforeEach(function (done) {
      database.set(this.blog.id, fakeAccount(), done);
    });

    it("a valid account", function (done) {
      database.drop(this.blog.id, done);
    });
  });

  describe("error fields", function () {
    it("defaults missing error_source and error_since", function (done) {
      var blogID = this.blog.id;
      database.set(blogID, fakeAccount(), function (err) {
        if (err) return done.fail(err);
        database.get(blogID, function (err, account) {
          if (err) return done.fail(err);
          expect(account.error_code).toBe(0);
          expect(account.error_source).toBe("");
          expect(account.error_since).toBe(0);
          done();
        });
      });
    });

    it("clears source and since when error_code is set to 0", function (done) {
      var blogID = this.blog.id;
      database.set(
        blogID,
        fakeAccount({
          error_code: 401,
          error_source: "auth",
          error_since: 99,
        }),
        function (err) {
          if (err) return done.fail(err);
          database.set(blogID, { error_code: 0 }, function (err) {
            if (err) return done.fail(err);
            database.get(blogID, function (err, account) {
              if (err) return done.fail(err);
              expect(account.error_code).toBe(0);
              expect(account.error_source).toBe("");
              expect(account.error_since).toBe(0);
              done();
            });
          });
        }
      );
    });

    it("preserves error_since when the same error is recorded again", function (done) {
      var blogID = this.blog.id;
      var firstSince;
      database.set(blogID, fakeAccount(), function (err) {
        if (err) return done.fail(err);
        database.setError(
          blogID,
          { persist: true, status: 401, source: "auth" },
          function (err) {
            if (err) return done.fail(err);
            database.get(blogID, function (err, account) {
              if (err) return done.fail(err);
              firstSince = account.error_since;
              expect(firstSince).toBeGreaterThan(0);
              setTimeout(function () {
                database.setError(
                  blogID,
                  { persist: true, status: 401, source: "auth" },
                  function (err) {
                    if (err) return done.fail(err);
                    database.get(blogID, function (err, account) {
                      if (err) return done.fail(err);
                      expect(account.error_since).toBe(firstSince);
                      expect(account.error_code).toBe(401);
                      expect(account.error_source).toBe("auth");
                      done();
                    });
                  }
                );
              }, 10);
            });
          }
        );
      });
    });
  });

  function fakeAccount(overrides) {
    return Object.assign(
      {
        account_id: "XXXXX",
        access_token: "YYYYY",
        refresh_token: "ZZZZ",
        email: "",
        error_code: 0,
        last_sync: Date.now(),
        full_access: false,
        folder: "",
        folder_id: "",
        cursor: "",
      },
      overrides || {}
    );
  }
});
