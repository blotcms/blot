describe("user", function () {
  global.test.user();

  var set = require("../index").set;
  var client = require("models/client");
  var key = require("../key");

  // paymentMethods was added to the user model after real user records
  // already existed in Redis without it. Simulate one of those legacy
  // records here: set() must default the missing field rather than
  // throwing when it strictly validates the record before saving.
  it("defaults paymentMethods on a record written before that field existed", function (done) {
    var test = this;

    (async function () {
      try {
        var stored = JSON.parse(await client.get(key.user(test.user.uid)));
        delete stored.paymentMethods;
        await client.set(key.user(test.user.uid), JSON.stringify(stored));

        set(test.user.uid, { lastSession: "abc" }, function (err) {
          if (err) return done.fail(err);

          require("../getById")(test.user.uid, function (err, user) {
            if (err) return done.fail(err);
            expect(user.paymentMethods).toEqual([]);
            done();
          });
        });
      } catch (err) {
        done.fail(err);
      }
    })();
  });

  it("set will remove key for old email when email changes", function (done) {
    var test = this;

    (async function () {
      try {
        var uid = await client.get(key.email(test.user.email));
        expect(uid).toEqual(test.user.uid);

        set(uid, { email: "foo@gmail.com" }, async function (err) {
          if (err) return done.fail(err);

          try {
            var updatedUid = await client.get(key.email(test.user.email));
            expect(updatedUid).toEqual(null);
            done();
          } catch (err) {
            done.fail(err);
          }
        });
      } catch (err) {
        done.fail(err);
      }
    })();
  });
});
