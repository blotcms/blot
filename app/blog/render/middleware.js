const ERROR = require("./error");
const loadView = require("./load");
const finalRender = require("./main");
const retrieve = require("./retrieve");
const listingViews = require("./listingViews");
const getCachedFullView = require("./full-view-cache");

const ensure = require("helper/ensure");
const extend = require("helper/extend");
const getTemplateSortOptions = require("blog/sortOptions");
const callOnce = require("helper/callOnce");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const config = require("config");
const fromCloudflare = require("../lib/fromCloudflare");
const CACHE = config.cache;

const CONTENT_TYPE = "Content-Type";
const CACHE_CONTROL = "Cache-Control";

const replaceFolderLinks = require("./replaceFolderLinks/html");
const replaceFolderLinksCSS = require("./replaceFolderLinks/css");
const BLOT_CDN_TOKEN = require("./replaceFolderLinks/cdnToken");
const renderTimeMetric = require("./renderTimeMetric");

const cacheDuration = "public, max-age=31536000";
const JS = "text/javascript";
const STYLE = "text/css";

module.exports = function attachRenderView(req, res, _next) {
  res.renderView = render;
  return _next();

  async function render(name, next, callback) {
    ensure(name, "string").and(next, "function");

    if (!req.template) return next();

    // Timed from here to the actual res.send(output) below, which is the
    // one point every real page request converges on - not the debug/json
    // inspection branch or the callback path used by non-HTTP callers (e.g.
    // CDN manifest generation).
    const renderStartedAt = process.hrtime.bigint();

    const blog = req.blog;
    const templateID = req.template.id;
    const cloudflare = fromCloudflare(req);

    // The real CDN origin, downgraded to http when the request itself was
    // served over http and isn't behind Cloudflare - mirrors the existing
    // protocol-downgrade trick for the {{cdn}}/{{public}} helper case below.
    function resolveCdnOrigin() {
      let cdnOrigin = config.cdn.origin;

      if (req.protocol === "http" && cloudflare === false) {
        cdnOrigin = cdnOrigin.split("https://").join("http://");
      }

      return cdnOrigin;
    }

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

      listingViews.ensureRetrieve(name, missingLocals);

      const foundLocals = await retrieve(req, res, missingLocals);
      extend(res.locals).and(foundLocals);
      listingViews.aliasLocals(name, req, res, foundLocals);

      try {
        await loadView(req, res);
      } catch (e) {
        // An outage is not a template problem, and a 400 would be cached
        return next(isRedisUnavailableError(e) ? e : ERROR.BAD_LOCALS());
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
        // res.locals.entry.html (and any other locals derived from entry
        // HTML) can contain build-time-baked %%BLOT_CDN%% tokens (see
        // app/build/plugins/folderAssets) that are normally only resolved
        // by the unconditional replace below, which runs after
        // finalRender - this branch returns before that point. Resolve
        // the token here too, the same way, so this endpoint never leaks
        // the raw placeholder instead of a working CDN URL.
        const debugJSON = JSON.stringify(res.locals)
          .split(BLOT_CDN_TOKEN)
          .join(resolveCdnOrigin());

        if (callback) return callback(null, JSON.parse(debugJSON));
        res.set("Cache-Control", "no-cache");
        res.type("json");
        return res.send(debugJSON);
      }

      let output;

      try {
        output = finalRender(view, locals, partials);
      } catch (e) {
        return next(ERROR.BAD_LOCALS());
      }

      // Replace protocol of CDN links for requests served over HTTP. This
      // is the separate, pre-existing {{cdn}}/{{public}} template-helper
      // case, which hardcodes config.cdn.origin directly.
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
      } else if (viewType === STYLE && !req.preview) {
        req.log("Replacing folder links with CDN links");
        output = await replaceFolderLinksCSS(blog, output, req.log);
        req.log("Replaced folder links with CDN links");
      }

      // Resolve the %%BLOT_CDN%% token baked into build-time-baked entry
      // HTML (see app/build/plugins/folderAssets) into the real CDN
      // origin. This must run unconditionally - for both the callback path
      // (e.g. CDN manifest generation) and the normal response path below
      // - since it's the one place every path converges. This is also the
      // natural future hook for CDN white-labeling / same-host routing:
      // only this resolution step would need to change.
      if (output.indexOf(BLOT_CDN_TOKEN) > -1) {
        output = output.split(BLOT_CDN_TOKEN).join(resolveCdnOrigin());
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

        // Reload the preview when rendered output changes: folder sync, or a
        // template editor save of package.json locals. See
        // helper/publishPreviewReload.js and blog/routes/preview-reload.js.
        output = output
          .split("</body>")
          .join(
            "<script>new EventSource('/__blot/preview/reload').onmessage = function() { window.location.reload(); };</script></body>"
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
        // Templates can expose CSS/JS through this same path (view.js routes
        // any URL to whatever view matches, not just pages) - only count
        // actual HTML page renders, not asset requests with very different
        // latency and cache behavior.
        if (viewType === "text/html") {
          renderTimeMetric.record(
            Number(process.hrtime.bigint() - renderStartedAt) / 1e6
          );
        }
        res.send(output);
      } catch (e) {
        next(e);
      }
    } catch (err) {
      return next(err);
    }
  }
};
