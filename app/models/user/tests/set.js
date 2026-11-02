describe("user", function () {
  global.test.user();

  var set = require("../index").set;
  var client = require("models/client");
  var key = require("../key");

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
