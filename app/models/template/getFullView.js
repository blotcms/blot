var getView = require("./getView");
var ensure = require("helper/ensure");
var getPartials = require("./getPartials");
var parseTemplate = require("./parseTemplate");
var mergeRetrieve = require("./util/mergeRetrieve");
var hardenProjectedRetrieve = require("./util/hardenProjectedRetrieve");
var mime = require("mime-types");

// This method is used to retrieve the locals,
// partials and missing locals for a given view.
module.exports = function getFullView(blogID, templateID, viewName, callback) {
  ensure(blogID, "string")
    .and(templateID, "string")
    .and(viewName, "string")
    .and(callback, "function");

  getView(templateID, viewName, function (err, view) {
    if (err || !view) return callback(err);

    // View has:
    //
    // - content (string) of the template view
    // - retrieve (object) locals embedded in the view
    //                     which need to be fetched.
    // - partials (object) partials in view

    var partialContexts = parseTemplate.getPartialContexts(view.content || "", "");

    getPartials(
      blogID,
      templateID,
      view.partials,
      function (err, allPartials, retrieveFromPartials) {
        if (err) return callback(err);

        // allPartials (object) viewname : viewcontent

        // Now we've fetched the partials we need to
        // append the missing locals in the partials...
        mergeRetrieve(view.retrieve, retrieveFromPartials);

        // Backstop: never let projection drop a heavy entry field that is
        // referenced anywhere in the assembled view + partials + locals bundle.
        hardenProjectedRetrieve(
          view.retrieve,
          view.content,
          allPartials,
          view.locals
        );

        var response = [
          view.locals,
          allPartials,
          view.retrieve,
          view.type || mime.lookup(view.name) || "text/html",
          view.content,
        ];

        return callback(null, response);
      },
      partialContexts,
      ""
    );
  });
};
