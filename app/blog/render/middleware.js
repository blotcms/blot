const ERROR = require("./error");
const loadView = require("./load");
const renderLocals = require("./locals");
const finalRender = require("./main");
const retrieve = require("./retrieve");
const getCachedFullView = require("./full-view-cache");
const hardenProjectedRetrieve = require("models/template/util/hardenProjectedRetrieve");

const ensure = require("helper/ensure");
const extend = require("helper/extend");
const getTemplateSortOptions = require("blog/sortOptions");
const callOnce = require("helper/callOnce");
const config = require("config");
const fromCloudflare = require("../lib/fromCloudflare");
const CACHE = config.cache;

const CONTENT_TYPE = "Content-Type";
const CACHE_CONTROL = "Cache-Control";

const replaceFolderLinks = require("./replaceFolderLinks/html");
const replaceFolderLinksCSS = require("./replaceFolderLinks/css");

const cacheDuration = "public, max-age=31536000";
const JS = "text/javascript";
const STYLE = "text/css";

module.exports = function attachRenderView(req, res, _next) {
  res.renderView = render;
  return _next();

  async function render(name, next, callback) {
    ensure(name, "string").and(next, "function");

    if (!req.template) return next();

    const blog = req.blog;
    const templateID = req.template.id;
    const cloudflare = fromCloudflare(req);

    if (callback) callback = callOnce(callback);

    try {
      const response = await getCachedFullView({
        blog,
        template: req.template,
        viewName: name,
      });

      if (!response) {
        const err = new Error(
          `The view '${name}' does not exist under templateID=${templateID}`
        );
        err.code = "NO_VIEW";
        return next(err);
      }

      req.log("Loaded view");

      const viewLocals = response[0];
      const viewPartials = response[1];
      const missingLocals = response[2];
      const viewType = response[3];
      const view = response[4];
      const query = Object.keys(req.query).length ? { query: req.query } : {};

      extend(res.locals)
        .and(query)
        .and(viewLocals)
        .and(req.template.locals)
        .and(blog.locals);

      // Templates may configure sorting as nested `sort: { by, direction }`.
      // Expose the resolved selection as flat sort_by / sort_order so views
      // (e.g. Hypertext's navigation) don't have to re-derive it.
      if (req.template.locals && req.template.locals.sort) {
        const resolvedSort = getTemplateSortOptions(req.template.locals);
        if (resolvedSort.sortBy !== undefined)
          res.locals.sort_by = resolvedSort.sortBy;
        if (resolvedSort.order !== undefined)
          res.locals.sort_order = resolvedSort.order;
      }

      extend(res.locals.partials).and(viewPartials);

      // getFullView hardened the projection metadata against the view's own
      // content, partials and locals. res.locals now also holds the query,
      // template- and blog-level locals merged above, and renderLocals
      // evaluates the mustache in all of them - fold their references in
      // before projection runs at retrieve time. Skip `partials` (already
      // covered by getFullView, and large).
      const localsForHardening = {};
      Object.keys(res.locals).forEach((k) => {
        if (k !== "partials") localsForHardening[k] = res.locals[k];
      });
      hardenProjectedRetrieve(missingLocals, null, null, localsForHardening);

      const foundLocals = await retrieve(req, res, missingLocals);
      extend(res.locals).and(foundLocals);

      try {
        await loadView(req, res);
        renderLocals(req, res);
      } catch (e) {
        return next(ERROR.BAD_LOCALS());
      }

      req.log("Loaded other locals");

      const locals = res.locals;
      const partials = res.locals.partials;

      // This is a public inspection interface for public blog pages. Its
      // output intentionally includes partials, template and blog locals,
      // and rendered published-entry data: Blot treats everything in the
      // public render context as public. Never put credentials, private
      // account data, unpublished entries, or other secrets in res.locals.
      // Keep this response no-cache and public (not preview-only) unless
      // Blot's public-template policy changes.
      if (req.query && (req.query.debug || req.query.json)) {
        if (callback) return callback(null, res.locals);
        res.set("Cache-Control", "no-cache");
        return res.json(res.locals);
      }

      let output;

      try {
        output = finalRender(view, locals, partials);
      } catch (e) {
        return next(ERROR.BAD_LOCALS());
      }

      // Replace protocol of CDN links for requests served over HTTP
      if (
        viewType.indexOf("text/") > -1 &&
        req.protocol === "http" &&
        cloudflare === false &&
        output.indexOf(config.cdn.origin) > -1
      ) {
        output = output
          .split(config.cdn.origin)
          .join(config.cdn.origin.split("https://").join("http://"));
      }

      if (viewType === "text/html" && !req.preview) {
        req.log("Replacing folder links with CDN links");
        output = await replaceFolderLinks(blog, output, req.log);
        req.log("Replaced folder links with CDN links");
      } else if (viewType === "text/css" && !req.preview) {
        req.log("Replacing folder links with CDN links");
        output = await replaceFolderLinksCSS(blog, output, req.log);
        req.log("Replaced folder links with CDN links");
      }

      if (callback) {
        return callback(null, output);
      }

      // We need to persist the page shown on the preview inside the
      // template editor. To do this, we send the page viewed to the
      // parent window (i.e. the page which embeds the preview in an
      // iframe). If we can work out how to do this in a cross origin
      // fashion with injecting a script, then remove this.
      if (req.preview && viewType === "text/html") {
        output = output
          .split("</body>")
          .join(
            "<script>window.onload = function() {window.top.postMessage('iframe:' +  window.location.pathname, '*');};</script></body>"
          );
      }

      // Only cache JavaScript and CSS if the request is not to a preview
      // subdomain and Blot's caching is turned on.
      if (CACHE && !req.preview && (viewType === STYLE || viewType === JS)) {
        res.header(CACHE_CONTROL, cacheDuration);
      }

      try {
        req.log("Sending response");
        res.header(CONTENT_TYPE, viewType);
        // This lets browsers send 'If-Modified-Since' requests
        // to check if the page has changed since the last time
        res.header("Last-Modified", new Date(blog.cacheID).toUTCString());
        res.send(output);
      } catch (e) {
        next(e);
      }
    } catch (err) {
      return next(err);
    }
  }
};
