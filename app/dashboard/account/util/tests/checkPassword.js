var User = require("models/user");
var checkPassword = require("../checkPassword");
var { MAX_PASSWORD_LENGTH } = require("models/user/auth-limits");

describe("account password verification", function () {
  it("rejects a password that exceeds the bcrypt byte limit before checking it", function (done) {
    spyOn(User, "checkPassword");
    var password = "a".repeat(MAX_PASSWORD_LENGTH + 1);

    checkPassword(
      { body: { password }, user: { uid: "too-long-password" } },
      {},
      function (err) {
        expect(err.message).toEqual("Your password is too long.");
        expect(User.checkPassword).not.toHaveBeenCalled();
        done();
      }
    );
  });
});
