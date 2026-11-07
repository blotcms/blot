describe("user", function () {
  global.test.user();

  var set = require("../index").set;
  var client = require("models/client");
  var key = require("../key");

  it("set will remove key for old email when email changes", async function () {
    var test = this;

    var uid = await client.get(key.email(test.user.email));
    expect(uid).toEqual(test.user.uid);

    await set(uid, { email: "foo@gmail.com" });

    var updatedUid = await client.get(key.email(test.user.email));
    expect(updatedUid).toEqual(null);
  });
});
