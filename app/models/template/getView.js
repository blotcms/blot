var key = require("./key");
var client = require("models/client");
var deserialize = require("./util/deserialize");
var viewModel = require("./viewModel");

module.exports = async function getView(templateID, viewID) {
  var match;

  var view = await client.hGetAll(key.view(templateID, viewID));

  if (view && Object.keys(view).length) {
    return deserialize(view, viewModel);
  }

  var views = await client.sMembers(key.allViews(templateID));

  views.forEach(function (viewname) {
    var name = viewname.slice(0, viewname.lastIndexOf("."));
    if (name === viewID) match = viewname;
  });

  if (!match) throw new Error("No view: " + viewID);

  var matchedView = await client.hGetAll(key.view(templateID, match));

  if (!matchedView || !Object.keys(matchedView).length)
    throw new Error("No view: " + viewID);

  return deserialize(matchedView, viewModel);
};
