const User = require("models/user");
const checkEmail = require("../checkEmail");
const checkPassword = require("../checkPassword");
const { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH } = require("models/user/auth-limits");

describe("log in authentication limits", function () {
  it("rejects an email that is too long before looking it up", function (done) {
    spyOn(User, "getByEmail");

    checkEmail(
      { body: { email: "a".repeat(MAX_EMAIL_LENGTH + 1) } },
      { locals: {} },
      function (err) {
        expect(err.code).toEqual("EMAILTOOLONG");
        expect(User.getByEmail).not.toHaveBeenCalled();
        done();
      }
    );
  });

  it("rejects a password that is too long before checking it", function (done) {
    spyOn(User, "checkPassword");

    const req = {
      body: { password: "a".repeat(MAX_PASSWORD_LENGTH + 1) },
      query: {},
      user: { uid: "too-long-password" },
    };

    checkPassword(req, {}, function (err) {
      expect(err.code).toEqual("PASSWORDTOOLONG");
      expect(User.checkPassword).not.toHaveBeenCalled();
      done();
    });
  });
});
