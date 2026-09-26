const health = require("clients/health");
const database = require("../database");
const getHealth = require("../getHealth");
const { SOURCES } = require("../util/classifyError");

describe("dropbox getHealth", function () {
  global.test.blog();

  function save(changes, done) {
    database.set(
      this.blog.id,
      Object.assign(
        {
          account_id: "id",
          access_token: "token",
          refresh_token: "refresh",
          email: "a@b.c",
          last_sync: Date.now(),
          full_access: false,
          folder: "",
          folder_id: "",
          cursor: "",
        },
        changes
      ),
      done
    );
  }

  afterEach(function (done) {
    database.drop(this.blog.id, done);
  });

  it("returns ok when there is no Dropbox account", async function () {
    const result = await getHealth(this.blog.id);
    expect(result).toEqual(health.ok());
  });

  it("returns ok when error_code is 0", function (done) {
    const blogID = this.blog.id;
    save.call(this, { error_code: 0 }, async function (err) {
      if (err) return done.fail(err);
      try {
        expect(await getHealth(blogID)).toEqual(health.ok());
        done();
      } catch (e) {
        done.fail(e);
      }
    });
  });

  it("maps 401 to REAUTH_REQUIRED and keeps since", function (done) {
    const blogID = this.blog.id;
    save.call(
      this,
      { error_code: 401, error_source: SOURCES.AUTH, error_since: 123 },
      async function (err) {
        if (err) return done.fail(err);
        try {
          const result = await getHealth(blogID);
          expect(result.state).toBe(health.STATES.ERROR);
          expect(result.issues[0]).toEqual({
            code: health.CODES.REAUTH_REQUIRED,
            message: health.ISSUES.REAUTH_REQUIRED.message,
            since: 123,
          });
          done();
        } catch (e) {
          done.fail(e);
        }
      }
    );
  });

  it("maps a legacy 409 without error_source to SOURCE_MISSING", function (done) {
    const blogID = this.blog.id;
    save.call(this, { error_code: 409 }, async function (err) {
      if (err) return done.fail(err);
      try {
        const result = await getHealth(blogID);
        expect(result.issues[0].code).toBe(health.CODES.SOURCE_MISSING);
        done();
      } catch (e) {
        done.fail(e);
      }
    });
  });

  it("does not surface a stale 500", function (done) {
    const blogID = this.blog.id;
    save.call(this, { error_code: 500 }, async function (err) {
      if (err) return done.fail(err);
      try {
        expect(await getHealth(blogID)).toEqual(health.ok());
        done();
      } catch (e) {
        done.fail(e);
      }
    });
  });

  it("maps 507 to QUOTA_EXCEEDED", function (done) {
    const blogID = this.blog.id;
    save.call(this, { error_code: 507 }, async function (err) {
      if (err) return done.fail(err);
      try {
        const result = await getHealth(blogID);
        expect(result.issues[0].code).toBe(health.CODES.QUOTA_EXCEEDED);
        done();
      } catch (e) {
        done.fail(e);
      }
    });
  });

  // routes/dashboard.js's /redirect clears error_code to 0 before sending
  // the user to Dropbox (to avoid a stale-error race for a successful
  // reconnect), then /authenticate restores the pre-redirect error_code/
  // error_source/error_since if the user cancels or the token exchange
  // fails - see the dropboxPriorError comments there. This mirrors that
  // restore and confirms getHealth reports the issue again afterwards
  // rather than the blog looking healthy after a cancelled reconnect.
  it("reports the prior issue again once it's restored after a cancelled reconnect", function (done) {
    const blogID = this.blog.id;
    save.call(
      this,
      { error_code: 401, error_source: SOURCES.AUTH, error_since: 123 },
      function (err) {
        if (err) return done.fail(err);

        // /redirect's optimistic clear.
        database.set(blogID, { error_code: 0 }, function (err) {
          if (err) return done.fail(err);

          getHealth(blogID).then(function (result) {
            expect(result).toEqual(health.ok());

            // /authenticate's restore, using the values captured before
            // the clear above (as dropboxPriorError does in the session).
            database.set(
              blogID,
              {
                error_code: 401,
                error_source: SOURCES.AUTH,
                error_since: 123,
              },
              async function (err) {
                if (err) return done.fail(err);
                try {
                  const restored = await getHealth(blogID);
                  expect(restored.state).toBe(health.STATES.ERROR);
                  expect(restored.issues[0]).toEqual({
                    code: health.CODES.REAUTH_REQUIRED,
                    message: health.ISSUES.REAUTH_REQUIRED.message,
                    since: 123,
                  });
                  done();
                } catch (e) {
                  done.fail(e);
                }
              }
            );
          }, done.fail);
        });
      }
    );
  });

  it("reports REAUTH_REQUIRED after persistError records a 401", function (done) {
    const blogID = this.blog.id;
    const persistError = require("../util/persistError");
    save.call(this, { error_code: 0 }, function (err) {
      if (err) return done.fail(err);
      persistError(blogID, { status: 401 }, SOURCES.APPLY, async function (err) {
        if (err) return done.fail(err);
        try {
          const result = await getHealth(blogID);
          expect(result.issues[0].code).toBe(health.CODES.REAUTH_REQUIRED);
          done();
        } catch (e) {
          done.fail(e);
        }
      });
    });
  });
});
