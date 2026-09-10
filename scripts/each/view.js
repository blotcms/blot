var eachTemplate = require("./template");
var Template = require("models/template");
var async = require("async");
var progress = require("./progress");

module.exports = function (doThis, callback) {
  eachTemplate(function (user, blog, template, nextTemplate) {
    Template.getAllViews(template.id, function (err, views) {
      if (err) throw err;

      var bar = progress.push("View", Object.keys(views || {}).length);

      async.eachOfSeries(
        views,
        function (view, name, done) {
          var nextView = function (err) {
            bar.tick();
            done(err);
          };

          doThis(user, blog, template, view, nextView);
        },
        function (err) {
          bar.pop();
          nextTemplate(err);
        }
      );
    });
  }, callback);
};
