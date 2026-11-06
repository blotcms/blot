var eachTemplate = require("./template");
var Template = require("models/template");
var ensure = require("helper/ensure");
var { promisify } = require("util");
var progress = require("./progress");

// The promise core. doThis is (user, blog, template, view) and may return a promise.
function eachView(doThis) {
  return eachTemplate.promise(async function (user, blog, template) {
    var { views } = await Template.getAllViews(template.id);

    var names = Object.keys(views || {});
    var bar = progress.push("View", names.length);

    try {
      for (const name of names) {
        try {
          await doThis(user, blog, template, views[name]);
        } finally {
          bar.tick();
        }
      }
    } finally {
      bar.pop();
    }
  });
}

// Callback API, for the scripts that still pass doThis(user, blog, template, view, next).
module.exports = function (doThis, callback) {
  ensure(doThis, "function");

  eachView(promisify(doThis)).then(
    () => callback(null),
    (err) => callback(err)
  );
};

module.exports.promise = eachView;
