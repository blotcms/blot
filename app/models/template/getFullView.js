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
// Uncached: Template.getFullView is ./fullViewCache, which calls this.
module.exports = async function getFullView(blogID, templateID, viewName) {
  ensure(blogID, "string").and(templateID, "string").and(viewName, "string");

  const view = await getView(templateID, viewName);

  if (!view) return null;

  // View has:
  //
  // - content (string) of the template view
  // - retrieve (object) locals embedded in the view
  //                     which need to be fetched.
  // - partials (object) partials in view

  const partialContexts = parseTemplate.getPartialContexts(
    view.content || "",
    ""
  );

  const wrapOptions = await folderLinkOptions(blogID, templateID);

  const partialsResult = await getPartials(
    blogID,
    templateID,
    view.partials,
    partialContexts,
    "",
    wrapOptions
  );

  const allPartials = partialsResult.allPartials;
  const retrieveFromPartials = partialsResult.retrieve;

  // allPartials (object) viewname : viewcontent

  // Now we've fetched the partials we need to
  // append the missing locals in the partials...
  mergeRetrieve(view.retrieve, retrieveFromPartials);

  // Backstop: never let projection drop a heavy entry field that is
  // referenced anywhere in the assembled view + partials bundle.
  hardenProjectedRetrieve(view.retrieve, view.content, allPartials);

  // Whether anything in the bundle can render entries' backlinks;
  // when not, rendering skips resolving them (blog/render/load).
  const usesBacklinks = referencedIdentifiers(view.content, allPartials).has(
    "backlinks"
  );

  // The render source: on the blog's own template, literal links to
  // files in its folder are wrapped in {{#cdn}} (see
  // util/resolveFolderLinks), and the targets added to retrieve.cdn
  // so the helper is loaded. view.content, which everything above
  // analyses, is left as the author wrote it.
  let source = view.content;

  if (wrapOptions) {
    const wrapped = wrapFolderLinks(
      view.content,
      Object.assign({ viewName: view.name }, wrapOptions)
    );

    source = wrapped.content;

    if (wrapped.targets.length)
      view.retrieve = mergeRetrieve(view.retrieve, {
        cdn: wrapped.targets,
      });
  }

  return [
    view.locals,
    allPartials,
    view.retrieve,
    mime.lookup(view.name) || "text/html",
    source,
    usesBacklinks,
  ];
};

// Folder links are only wrapped when the blog rendering the view owns the
// template (template IDs are "<owner>:<slug>"): the CDN manifest resolves
// them against the owner's folder. SITE templates render for many blogs and
// are never wrapped. Resolves with the wrapping options (the blog's
// current hosts, see blog/lib/blogHosts), or null not to wrap.
//
// This runs once per view per blog and template cacheID in each process
// (./fullViewCache), so this lookup and the wrapping don't run
// on every request. A new handle or domain bumps the cacheID (models/blog/set).
async function folderLinkOptions(blogID, templateID) {
  if (templateID.indexOf(blogID + ":") !== 0) return null;

  // Required here to avoid a dependency loop
  var Blog = require("models/blog");

  var blog = await Blog.get({ id: blogID });

  if (!blog || !blog.handle) return null;

  return { hosts: blogHosts(blog) };
}
