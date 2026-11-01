var ensure = require("helper/ensure");
var extend = require("helper/extend");
var defaults = require("./defaults");
var client = require("models/client");
var key = require("./key");
var set = require("./set");
var folder = require("storage/folder");
var callbackify = require("util").callbackify;
var User = require("../user");
var validate = require("./validate");
var generateID = require("./generateID");
var _ = require("lodash");

var UID_PLACEHOLDER = "";

module.exports = function create(uid, info, callback) {
  ensure(uid, "string").and(info, "object").and(callback, "function");

  var blogs;
  var blog;
  var title;
  var blogID;

  // Determine a title for the new blog. Falls
  // back to the handle then a placeholder
  if (info.title) {
    title = info.title;
  } else if (info.handle) {
    title = info.handle;
  } else {
    title = "Untitled blog";
  }

  try {
    blogID = generateID();
  } catch (e) {
    return callback(e);
  }

  blog = {
    owner: uid,
    id: blogID,
    title: title,
    client: "",
    timeZone: info.timeZone || "UTC",
    dateFormat: info.dateFormat || "M/D/YYYY",
  };

  var blogDefaults = _.cloneDeep(defaults);

  extend(blog).and(info).and(blogDefaults);

  validate(UID_PLACEHOLDER, blog, function (errors) {
    if (errors) return callback(errors);

    User.getById(uid, function (err, user) {
      if (err || !user) return callback(err || new Error("No user"));

      blogs = user.blogs || [];
      blogs.push(blogID);

      User.set(uid, { blogs: blogs, lastSession: blogID }, function (err) {
        if (err) return callback(err);

        client
          .sAdd(key.ids, blogID)
          .then(function () {
            set(blogID, blog, function (err) {
              if (err) return callback(err);

              // A new blog's folder is empty, but must exist
              callbackify(folder.mkdir)(blogID, "/", function (err) {
                if (err) return callback(err);

                return callback(err, blog);
              });
            });
          })
          .catch(callback);
      });
    });
  });
};
