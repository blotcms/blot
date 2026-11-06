require("templates");
const clfdate = require("helper/clfdate");

module.exports = function () {
  beforeAll(function (done) {
    console.log(clfdate(), "[tests] Building global templates");
    require("templates")({ watch: false }, function (err) {
      if (err) return done(err);
      console.log(clfdate(), "[tests] Built global templates");
      done();
    });
  }, 15 * 1000);
};
