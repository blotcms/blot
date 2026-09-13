// Older/custom templates bind {{#entries}} directly; official templates
// bind {{#posts}}. Both need the same page of entries, so route through the
// posts retriever - its per-request/process LRU cache means a view that
// also binds {{#posts}} reuses this fetch instead of calling
// Entries.getPage a second time. This does mean a plain {{#entries}} view
// now inherits posts()'s ?tag=/:tag filtering, which the old raw getPage
// call here ignored - accepted as part of standardizing on posts() as the
// single fetch path. See https://github.com/davidmerfield/blot/issues/1844
const retrievePosts = require("../render/retrieve/posts");
const getCachedFullView = require("../render/full-view-cache");

const VIEW_NAME = "entries.html";

module.exports = async function entries(req, res, next) {
  try {
    req.log("Loading entries");

    // retrievePosts resolves page_size/path_prefix/tag from res.locals,
    // falling back to req.template.locals. render/middleware.js only merges
    // the view's own locals (e.g. a per-view page_size override) into
    // res.locals once renderView runs, which is after this route would
    // otherwise have already fetched with the wrong fallback - silently
    // priming the shared cache under the same key a later, correctly
    // resolved {{#posts}} fetch would use, but with the wrong page size.
    // Resolve the view's locals now (getCachedFullView is itself
    // LRU-cached, so renderView's own lookup a moment later is a cache
    // hit) so both fetches agree.
    const view = await getCachedFullView({
      blog: req.blog,
      template: req.template,
      viewName: VIEW_NAME,
    });
    const viewLocals = (view && view[0]) || {};

    if (viewLocals.page_size !== undefined) {
      res.locals.page_size = viewLocals.page_size;
    }
    if (viewLocals.path_prefix !== undefined) {
      res.locals.path_prefix = viewLocals.path_prefix;
    }
    if (viewLocals.tag !== undefined) {
      res.locals.tag = viewLocals.tag;
    }

    // retrievePosts sets res.locals.pagination as a side effect.
    const entries = await retrievePosts(req, res);
    req.log("Loaded entries");

    res.locals.entries = entries;

    res.renderView(VIEW_NAME, next);
  } catch (err) {
    req.log("Error loading entries");
    return next(err);
  }
};
