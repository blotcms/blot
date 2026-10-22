var getView = require("./getView");
var ensure = require("helper/ensure");
var getPartials = require("./getPartials");
var parseTemplate = require("./parseTemplate");
var mergeRetrieve = require("./util/mergeRetrieve");
var hardenProjectedRetrieve = require("./util/hardenProjectedRetrieve");
var referencedIdentifiers = require("./util/referencedIdentifiers");
var { wrapFolderLinks } = require("./util/resolveFolderLinks");
var blogHosts = require("blog/lib/blogHosts");
var mime = require("mime-types");

// This method is used to retrieve the locals,
// partials and missing locals for a given view, and whether it uses backlinks.
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

    folderLinkOptions(blogID, templateID, function (err, wrapOptions) {
      if (err) return callback(err);

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
          // referenced anywhere in the assembled view + partials bundle.
          hardenProjectedRetrieve(view.retrieve, view.content, allPartials);

          // Whether anything in the bundle can render entries' backlinks;
          // when not, rendering skips resolving them (blog/render/load).
          var usesBacklinks = referencedIdentifiers(
            view.content,
            allPartials
          ).has("backlinks");

          // The render source: on the blog's own template, literal links to
          // files in its folder are wrapped in {{#cdn}} (see
          // util/resolveFolderLinks), and the targets added to retrieve.cdn
          // so the helper is loaded. view.content, which everything above
          // analyses, is left as the author wrote it.
          var source = view.content;

          if (wrapOptions) {
            var wrapped = wrapFolderLinks(
              view.content,
              Object.assign({ viewName: view.name, viewType: view.type }, wrapOptions)
            );

            source = wrapped.content;

            if (wrapped.targets.length)
              view.retrieve = mergeRetrieve(view.retrieve, {
                cdn: wrapped.targets,
              });
          }

          var response = [
            view.locals,
            allPartials,
            view.retrieve,
            view.type || mime.lookup(view.name) || "text/html",
            source,
            usesBacklinks,
          ];

          return callback(null, response);
        },
        partialContexts,
        "",
        wrapOptions
      );
    });
  });
};

// Folder links are only wrapped when the blog rendering the view owns the
// template (template IDs are "<owner>:<slug>"): the CDN manifest resolves
// them against the owner's folder. SITE templates render for many blogs and
// are never wrapped. Calls back with the wrapping options (the blog's
// current hosts, see blog/lib/blogHosts), or null not to wrap.
//
// getFullView runs once per view per blog cacheID in each process
// (blog/render/full-view-cache), so this lookup and the wrapping don't run
// on every request. A new handle or domain bumps the cacheID (models/blog/set).
function folderLinkOptions(blogID, templateID, callback) {
  if (templateID.indexOf(blogID + ":") !== 0) return callback(null, null);

  // Required here to avoid a dependency loop
  var Blog = require("models/blog");

  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);
    if (!blog || !blog.handle) return callback(null, null);

    callback(null, { hosts: blogHosts(blog) });
  });
}
