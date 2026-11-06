var ensure = require("helper/ensure");
var extend = require("helper/extend");
var defaults = require("./defaults");
var client = require("models/client");
var key = require("./key");
var set = require("./set");
var folder = require("storage/folder");
var promisify = require("util").promisify;
var withCallback = require("helper/withCallback");
var User = require("../user");
var validate = require("./validate");
var generateID = require("./generateID");
var _ = require("lodash");

var UID_PLACEHOLDER = "";

// validate calls back (errors), errors being null or an object of messages
// keyed by field
function validateAsync(blog) {
  return new Promise(function (resolve, reject) {
    validate(UID_PLACEHOLDER, blog, function (errors) {
      if (errors) return reject(errors);
      resolve();
    });
  });
}

// User.set has no promise form yet
var setUser = promisify(User.set);

// Resolves to the new blog. Rejects with validate's errors object (fields
// mapped to errors) or the error that stopped the creation.
module.exports = withCallback(async function create(uid, info) {
  ensure(uid, "string").and(info, "object");

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

  blogID = generateID();

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

  await validateAsync(blog);

  var user = await User.getById(uid);
  if (!user) throw new Error("No user");

  blogs = user.blogs || [];
  blogs.push(blogID);

  await setUser(uid, { blogs: blogs, lastSession: blogID });

  await client.sAdd(key.ids, blogID);
  await set(blogID, blog);

  // A new blog's folder is empty, but must exist
  await folder.mkdir(blogID, "/");

  return blog;
});
