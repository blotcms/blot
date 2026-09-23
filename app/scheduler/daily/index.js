var Email = require("helper/email");
var async = require("async");
var clfdate = require("helper/clfdate");
var callOnce = require("helper/callOnce");

function main (callback) {
  var view = {};

  view.date = require("moment")().format("LL");

  function log (msg) {
    return function (cb) {
      console.log(clfdate(), "Daily update:", msg);
      cb(null, {});
    };
  }

  async.mapSeries(
    [
      log("Starting daily update"),
      log("Checking number of users"),
      require("./revenue"),
      log("Checking for blogs with new posts"),
      require("./new-posts"),
      log("Checking number of newsletter subscribers"),
      require("./newsletter-subscribers"),
      log("Checking for new customers"),
      require("./new-customers"),
      log("Checking p95 render time"),
      require("./render-time"),
      log("Finished daily update")
    ],
    function (fn, next) {
      fn(
        callOnce(function (err, res) {
          if (res) for (var i in res) view[i] = res[i];
          next();
        })
      );
    },
    function () {
      Email.DAILY_UPDATE("", view, callback);
    }
  );
}

if (require.main === module) require("./cli")(main);

module.exports = main;
