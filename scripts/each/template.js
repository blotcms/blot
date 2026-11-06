var eachBlog = require("./blog");
var Template = require("models/template");
var ensure = require("helper/ensure");
var { promisify } = require("util");
var progress = require("./progress");

// The promise core. doThis is (user, blog, template) and may return a promise.
function eachTemplate(doThis) {
  return eachBlog.promise(async function (user, blog) {
    var templates = await Template.getTemplateList(blog.id);

    var owned = (templates || []).filter(function (template) {
      return template.owner === blog.id;
    });

    var bar = progress.push("Template", owned.length);

    try {
      for (const template of owned) {
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

        try {
          await doThis(user, blog, template);
        } finally {
          bar.tick();
        }
      }
    } finally {
      bar.pop();
    }
  });
}

// Callback API, for the scripts that still pass doThis(user, blog, template, next).
module.exports = function (doThis, callback) {
  ensure(doThis, "function");

  eachTemplate(promisify(doThis)).then(
    () => callback(null),
    (err) => callback(err)
  );
};

module.exports.promise = eachTemplate;
