module.exports = function (done) {
  var User = require("models/user");
  if (!this.user || !this.user.uid) {
    return done();
  }
  var uid = this.user.uid;
  var finished = false;
  var timeout = setTimeout(function () {
    finish(new Error("removeUser timed out"));
  }, 10000);

  function finish(err) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    done(err);
  }

  User.remove(uid).then(function () {
    finish();
  }, finish);
};
