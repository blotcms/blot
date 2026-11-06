var key = require("./key");
var client = require("models/client");
var deserialize = require("./util/deserialize");
var viewModel = require("./viewModel");

module.exports = function getView(templateID, viewID, callback) {
  var match;

  client
    .hGetAll(key.view(templateID, viewID))
    .then(function (view) {
      if (view && Object.keys(view).length) {
        return callback(null, deserialize(view, viewModel));
      }

      return client.sMembers(key.allViews(templateID)).then(function (views) {
        views.forEach(function (viewname) {
          var name = viewname.slice(0, viewname.lastIndexOf("."));
          if (name === viewID) match = viewname;
        });

        if (!match) return callback(new Error("No view: " + viewID));

        return client
          .hGetAll(key.view(templateID, match))
          .then(function (matchedView) {
            if (!matchedView || !Object.keys(matchedView).length)
              return callback(new Error("No view: " + viewID));

            callback(null, deserialize(matchedView, viewModel));
          });
      });
    })
    .catch(callback);
};
