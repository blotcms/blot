var client = require("models/client");
var ensure = require("helper/ensure");
var key = require("./key");
var util = require("./util");
var matches = util.matches;

// var drop = require('./drop');

module.exports = async function set(blogID, mappings) {
  ensure(blogID, "string").and(mappings, "array");

  var redirects = key.redirects(blogID);

  var allKeys = await client.zRange(redirects, 0, -1);
  var multi = client.multi();

  allKeys = allKeys || [];
  allKeys = allKeys.map(function (from) {
    return key.redirect(blogID, from);
  });
  allKeys.push(redirects);

  multi.del(allKeys);

  mappings.forEach(function (redirect, index) {
    var from = redirect.from;
    var to = redirect.to;
    var fromKey = key.redirect(blogID, from);

    index = parseInt(index);

    if (isNaN(index)) throw new Error("forEach returned a NaN index");

    var candidates = mappings.slice(0, index);

    if (!from || !to || matches(to, candidates)) return;

    ensure(from, "string")
      .and(to, "string")
      .and(index, "number")
      .and(fromKey, "string")
      .and(redirects, "string");

    multi.zAdd(redirects, {
      score: index,
      value: from,
    });
    multi.set(fromKey, to);
  });

  await multi.exec();
};
