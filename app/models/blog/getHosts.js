var client = require("models/client");
var key = require("./key");
var getAllIDs = require("./getAllIDs");
var promiseOnly = require("helper/promiseOnly");

var HOST = require("config").host;

// Resolves to a list of [host, blogID] pairs
module.exports = promiseOnly(async function getHosts() {
  var ids = await getAllIDs();

  var res = await Promise.all(
    ids.map(function (id) {
      return client.hmGet(key.info(id), ["domain", "handle"]);
    })
  );

  var hosts = [];

  res.forEach(function (keys, i) {
    if (keys && keys[0]) hosts.push([keys[0], ids[i]]);
    if (keys && keys[1]) hosts.push([keys[1] + "." + HOST, ids[i]]);
  });

  return hosts;
});
