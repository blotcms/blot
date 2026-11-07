var nsv = require("helper/nsv");
var ensure = require("helper/ensure");

var NO_HANDLE = "Please enter a username.";
var BAD_CHARS = "Please use only letters and numbers for your username.";
var IN_USE = "That username was already in use.";
var TOO_SHORT = "Please choose a username longer than two letters.";
var TOO_LONG = "Please choose a username shorter than 70 letters.";

var BANNED_NAMES = nsv(__dirname + "/banned.txt");

var ONLY_ALPA_NUM = /^[a-zA-Z0-9]+$/;

// Resolves to the valid handle. Rejects with an Error.
module.exports = async function validateHandle(blogID, handle) {
  var get = require("../get");

  ensure(blogID, "string").and(handle, "string");

  handle = handle.toLowerCase().trim();

  if (handle === "") throw new Error(NO_HANDLE);
  if (!ONLY_ALPA_NUM.test(handle)) throw new Error(BAD_CHARS);
  if (BANNED_NAMES.indexOf(handle) > -1) throw new Error(IN_USE);
  if (handle.length < 2) throw new Error(TOO_SHORT);
  if (handle.length > 70) throw new Error(TOO_LONG);

  // A failed lookup is treated as the handle being free, as it was
  var blog;
  try {
    blog = await get({ handle: handle });
  } catch (err) {}

  // Sometimes we want to check if
  // a handle is in use before creating
  // a new blog. If so, we don't know
  // the blog's ID yet.
  if (blog && blog.id && blogID !== blog.id && blog.handle === handle) {
    var err = new Error(IN_USE);
    err.code = "EEXISTS";
    throw err;
  }

  return handle;
};
