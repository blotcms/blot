var key = require("./key");
var client = require("models/client");
var { RESP_TYPES } = require("redis");
var deserialize = require("./util/deserialize");
var viewContent = require("./util/viewContent");
var viewModel = require("./viewModel");

// The only reader of view hashes: see util/viewContent for why they are read
// as Buffers, and why nothing else may read them.
async function readView(viewKey) {
  var hash = await client
    .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
    .hGetAll(viewKey);

  if (!hash || !Object.keys(hash).length) return null;

  return deserialize(await viewContent.unpack(hash), viewModel);
}

module.exports = async function getView(templateID, viewID) {
  var match;

  var view = await readView(key.view(templateID, viewID));

  if (view) return view;

  var views = await client.sMembers(key.allViews(templateID));

  views.forEach(function (viewname) {
    var name = viewname.slice(0, viewname.lastIndexOf("."));
    if (name === viewID) match = viewname;
  });

  if (!match) throw new Error("No view: " + viewID);

  var matchedView = await readView(key.view(templateID, match));

  if (!matchedView) throw new Error("No view: " + viewID);

  return matchedView;
};
