var Email = require("../email");
var User = require("models/user");
var { MAX_EMAIL_LENGTH } = require("models/user/auth-limits");

describe("account email update", function () {
  it("rejects an email that exceeds the RFC length limit", async function () {
    spyOn(User, "set");
    var tooLong =
      "a".repeat(MAX_EMAIL_LENGTH - "@example.com".length + 1) + "@example.com";
    var req = {
      method: "POST",
      url: "/",
      user: { uid: "email-route-user" },
      body: { email: tooLong },
    };
    var result = await new Promise(function (resolve, reject) {
      Email.handle(
        req,
        {
          redirect: function (location) {
            resolve({ redirect: location });
          },
          message: function (location) {
            resolve({ saved: location });
          },
          render: function (view) {
            resolve({ view: view });
          },
        },
        function (err) {
          if (err) return resolve({ error: err });
          reject(new Error("Email route did not respond"));
        }
      );
    });

    expect(result.error.message).toEqual("Email address is too long");
    expect(User.set).not.toHaveBeenCalled();
  });
});
