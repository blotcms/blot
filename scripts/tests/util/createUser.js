var User = require("models/user");
var randomString = require("./randomString");

module.exports = function (done) {
  var context = this;
  var fakePassword = "XXX-" + Date.now();
  var fakeEmail = randomString(20) + "@example.com";
  var finished = false;
  var timeout = setTimeout(function () {
    finish(new Error("createUser timed out"));
  }, 10000);

  function finish(err) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    done(err);
  }

  User.hashPassword(fakePassword).then(function (passwordHash) {
    User.create(fakeEmail, passwordHash, {}, {}).then(function (user) {
      context.user = user;
      context.user.fakePassword = fakePassword;
      finish();
    }, finish);
  }, finish);
};
