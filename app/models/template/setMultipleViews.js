var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var setView = require("./setView");

module.exports = promiseOnly(async function setMultipleViews(name, views) {
  ensure(name, "string").and(views, "object");

  var error;
  var saves = [];

  // The views are saved together. As before, the outcome is that of the
  // last save to finish, so an earlier failure can be masked by a later
  // success.
  for (var i in views) {
    saves.push(
      setView(name, views[i]).then(
        function () {
          error = undefined;
        },
        function (err) {
          error = err;
        }
      )
    );
  }

  await Promise.all(saves);

  if (error) throw error;
});
