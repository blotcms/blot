describe("dropbox database", function () {
  var database = require("../database");

  // Create test blog
  global.test.blog();

  describe("sets", function () {
    it("a valid account", async function () {
      await database.set(this.blog.id, fakeAccount());
    });
  });

  describe("gets", function () {
    beforeEach(async function () {
      await database.set(this.blog.id, fakeAccount());
    });

    it("a valid account", async function () {
      await database.get(this.blog.id);
    });
  });

  describe("drops", function () {
    beforeEach(async function () {
      await database.set(this.blog.id, fakeAccount());
    });

    it("a valid account", async function () {
      await database.drop(this.blog.id);
    });
  });

  describe("promise form", function () {
    it("sets, gets and drops an account without a callback", async function () {
      const blogID = this.blog.id;

      expect(await database.get(blogID)).toBeNull();

      await database.set(blogID, fakeAccount());
      const account = await database.get(blogID);
      expect(account.account_id).toEqual("XXXXX");

      // The blog does not use the Dropbox client, so it is not listed
      expect(await database.listBlogs("XXXXX")).toEqual(jasmine.any(Array));

      await database.drop(blogID);
      expect(await database.get(blogID)).toBeNull();
    });
  });

  describe("error fields", function () {
    it("defaults missing error_source and error_since", async function () {
      var blogID = this.blog.id;
      await database.set(blogID, fakeAccount());
      const account = await database.get(blogID);
      expect(account.error_code).toBe(0);
      expect(account.error_source).toBe("");
      expect(account.error_since).toBe(0);
    });

    it("clears source and since when error_code is set to 0", async function () {
      var blogID = this.blog.id;
      await database.set(
        blogID,
        fakeAccount({
          error_code: 401,
          error_source: "auth",
          error_since: 99,
        })
      );
      await database.set(blogID, { error_code: 0 });
      const account = await database.get(blogID);
      expect(account.error_code).toBe(0);
      expect(account.error_source).toBe("");
      expect(account.error_since).toBe(0);
    });

    it("preserves error_since when the same error is recorded again", async function () {
      var blogID = this.blog.id;
      await database.set(blogID, fakeAccount());
      await database.setError(blogID, {
        persist: true,
        status: 401,
        source: "auth",
      });
      const first = await database.get(blogID);
      var firstSince = first.error_since;
      expect(firstSince).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      await database.setError(blogID, {
        persist: true,
        status: 401,
        source: "auth",
      });
      const account = await database.get(blogID);
      expect(account.error_since).toBe(firstSince);
      expect(account.error_code).toBe(401);
      expect(account.error_source).toBe("auth");
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
