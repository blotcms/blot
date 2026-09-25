var nsv = require("helper/nsv");
var ensure = require("helper/ensure");

var NO_HANDLE = "Please enter a username.";
var BAD_CHARS = "Please use only letters and numbers for your username.";
var IN_USE = "That username was already in use.";
var TOO_SHORT = "Please choose a username longer than two letters.";
var TOO_LONG = "Please choose a username shorter than 70 letters.";

var BANNED_NAMES = nsv(__dirname + "/banned.txt");

var ONLY_ALPA_NUM = /^[a-zA-Z0-9]+$/;

module.exports = function (blogID, handle, callback) {
  var get = require("../get");

  ensure(blogID, "string").and(handle, "string").and(callback, "function");

  handle = handle.toLowerCase().trim();

  if (handle === "") return callback(new Error(NO_HANDLE));

  if (!ONLY_ALPA_NUM.test(handle)) return callback(new Error(BAD_CHARS));

  if (BANNED_NAMES.indexOf(handle) > -1) return callback(new Error(IN_USE));

  if (handle.length < 2) return callback(new Error(TOO_SHORT));

  if (handle.length > 70) return callback(new Error(TOO_LONG));
  
  get({ handle: handle }, function (err, blog) {
    // Sometimes we want to check if
    // a handle is in use before creating
    // a new blog. If so, we don't know
    // the blog's ID yet.
    if (blog && blog.id && blogID !== blog.id && blog.handle === handle) {
      err = new Error(IN_USE);
      err.code = "EEXISTS";
      return callback(err);
    }

    return callback(null, handle);
  });
};
