var getView = require("./getView");

module.exports = function getMultipleViews(templateName, viewNames, callback) {
  var totalViews = viewNames.length,
    views = {};

  if (!totalViews) onFinish();

  for (var i in viewNames) getView(templateName, viewNames[i], onGet);

  function onGet(err, view) {
    // TO DO collect missing
    // partials or views and expose
    // them to the callback. Right now
    // nothing happens.
    // if (err) console.log(err);
    if (view && view.name) views[view.name] = view;
    if (!--totalViews) onFinish();
  }

  function onFinish() {
    // We don't pass errors
    // since we don't care
    // if one of the partials does
    // not exist.
    callback(null, views);
  }
};
