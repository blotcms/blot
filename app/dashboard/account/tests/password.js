var Password = require("../password");
var User = require("models/user");

function request(hasPassword, token, method) {
  return new Promise(function (resolve, reject) {
    var req = {
      method: method || "POST",
      url: "/set",
      // The dashboard user has been extended: only hasPassword remains.
      user: { uid: "password-route-user", hasPassword: hasPassword },
      session: token ? { passwordSetToken: token } : {},
      body: { newPasswordA: "new-password", newPasswordB: "new-password" },
    };
    var res = {
      redirect: function (location) { resolve({ redirect: location }); },
      message: function (location) { resolve({ saved: location }); },
      render: function (view) { resolve({ view: view }); },
    };
    Password.handle(req, res, function (err) {
      if (err) return resolve({ error: err });
      reject(new Error("Password route did not respond"));
    });
  });
}

describe("password setting authorization", function () {
  beforeEach(function () {
    spyOn(User, "hashPassword").and.callFake(function (password, callback) {
      callback(null, "hashed-password");
    });
    spyOn(User, "set").and.callFake(function (uid, updates, callback) {
      callback(null);
    });
    spyOn(User, "checkAccessToken").and.callFake(function (token, callback) {
      callback(null, "password-route-user");
    });
  });

  it("blocks existing-password accounts without a reset token on GET and POST", async function () {
    expect((await request(true, null, "GET")).redirect).toEqual("/");
    expect((await request(true)).redirect).toEqual("/");
    expect(User.hashPassword).not.toHaveBeenCalled();
    expect(User.set).not.toHaveBeenCalled();
  });

  it("allows a passwordless account to set its first password", async function () {
    expect((await request(false)).saved).toEqual("/sites");
    expect(User.checkAccessToken).not.toHaveBeenCalled();
    expect(User.set).toHaveBeenCalledWith("password-route-user", {
      passwordHash: "hashed-password",
    }, jasmine.any(Function));
  });

  it("allows a valid token for this account", async function () {
    expect((await request(true, "valid-token")).saved).toEqual("/sites");
    expect(User.checkAccessToken).toHaveBeenCalledWith("valid-token", jasmine.any(Function));
  });

  it("rejects expired or consumed tokens", async function () {
    User.checkAccessToken.and.callFake(function (token, callback) {
      callback(new Error("Invalid access token"));
    });
    expect((await request(true, "expired-token")).error.message).toEqual("Invalid access token");
    expect(User.set).not.toHaveBeenCalled();
  });

  it("rejects a token belonging to a different account", async function () {
    User.checkAccessToken.and.callFake(function (token, callback) {
      callback(null, "another-user");
    });
    expect((await request(true, "other-token")).error.message).toEqual("Your token was invalid.");
    expect(User.set).not.toHaveBeenCalled();
  });
});
