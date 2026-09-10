var eachBlog = require("./blog");
var Template = require("models/template");
var async = require("async");
var config = require("../../config");
var progress = require("./progress");

module.exports = function (doThis, callback) {
  eachBlog(function (user, blog, nextBlog) {
    Template.getTemplateList(blog.id, function (err, templates) {
      if (err) throw err;

      var owned = (templates || []).filter(function (template) {
        return template.owner === blog.id;
      });

      var bar = progress.push("Template", owned.length);

      async.eachSeries(
        owned,
        function (template, done) {
          var nextTemplate = function (err) {
            bar.tick();
            done(err);
          };

          // console.log();
          // console.log(
          //   blog.id + ".",
          //   template.slug,
          //   "(" + blog.handle + ")",
          //   "http://preview.my." +
          //     template.slug +
          //     "." +
          //     blog.handle +
          //     "." +
          //     config.host
          // );
          // console.log("----------------------------------------------------");

          doThis(user, blog, template, nextTemplate);
        },
        function (err) {
          bar.pop();
          nextBlog(err);
        }
      );
    });
  }, callback);
};
