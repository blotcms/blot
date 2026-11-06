var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var util = require("./util");
var map = util.map;
var notRegex = util.notRegex;

module.exports = async function get(blogID, from, input) {
  ensure(blogID, "string").and(from, "string");

  var fromKey = key.redirect(blogID, from);
  var to = await client.get(fromKey);

  if (notRegex(to) || !input) {
    return to;
  }

  // this is only neccessary for from, if from is a regex
  var redirect;

  try {
    redirect = map(input, from, to);
  } catch (e) {}

  // WE SHOULD CACHE THIS RESPONSE HERE.... ?
  // HOW TO BIND IT to the core FROM PATTERN ?
  redirect = redirect !== from ? redirect : null;

  return redirect;
};
