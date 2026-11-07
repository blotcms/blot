var eachBlog = require("./blog");
var Template = require("models/template");
var progress = require("./progress");

// Calls doThis(user, blog, template) for every template a blog owns. doThis
// may be async; a rejection stops the run.
function eachTemplate(doThis) {
  return eachBlog(async function (user, blog) {
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

module.exports = eachTemplate;
module.exports.promise = eachTemplate;
