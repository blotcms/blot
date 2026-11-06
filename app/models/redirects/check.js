var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var get = require("./get");
var util = require("./util");
var withCallback = require("helper/withCallback");
var is = util.is;
var isRegex = util.isRegex;

// get is not converted yet: it takes the input after its callback
function getRedirect(blogID, from, input) {
  return new Promise(function (resolve, reject) {
    get(
      blogID,
      from,
      function (err, redirect) {
        if (err) return reject(err);
        resolve(redirect);
      },
      input
    );
  });
}

module.exports = withCallback(async function check(blogID, input) {
  ensure(blogID, "string").and(input, "string");

  var redirects = key.redirects(blogID);

  var redirect = await getRedirect(blogID, input);

  if (redirect) return redirect;

  var cursor = "0";

  while (true) {
    // SORTED SET, precedence is important
    var response = await client.zScan(redirects, cursor);

    if (!response) return;

    cursor = response.cursor;
    var matches = response.members || [];

    if (!matches.length && cursor === "0") {
      return;
    }

    for (var i = 0; i < matches.length; i++) {
      var from = matches[i].value;

      if (isRegex(from) && is(input, from)) {
        return await getRedirect(blogID, from, input);
      }
    }

    if (cursor === "0") {
      return;
    }
  }
});
