var getView = require("./getView");

// Resolves to the views by name. A view which can't be read is left out:
// we don't care if one of the partials does not exist.
module.exports = async function getMultipleViews(templateName, viewNames) {
  var views = {};

  await Promise.all(
    viewNames.map(async function (viewName) {
      try {
        var view = await getView(templateName, viewName);
        if (view && view.name) views[view.name] = view;
      } catch (err) {
        // TO DO collect missing partials or views and expose them to the
        // caller. Right now nothing happens.
      }
    })
  );

  return views;
};
