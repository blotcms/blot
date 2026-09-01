var ERROR = require("./error");
var loadView = require("./load");
var renderLocals = require("./locals");
var finalRender = require("./main");
var retrieve = require("./retrieve");
var getCachedFullView = require("./full-view-cache");

var ensure = require("helper/ensure");
var extend = require("helper/extend");
var callOnce = require("helper/callOnce");
var config = require("config");
var CACHE = config.cache;

// The http headers
var CONTENT_TYPE = "Content-Type";
var CACHE_CONTROL = "Cache-Control";

const replaceFolderLinks = require("./replaceFolderLinks/html");
const replaceFolderLinksCSS = require("./replaceFolderLinks/css");

var cacheDuration = "public, max-age=31536000";
var JS = "text/javascript";
var STYLE = "text/css";

module.exports = function (req, res, _next) {
  res.renderView = render;

  return _next();

  function render(name, next, callback) {
    // console.log(req.url, 'rendering', viewName);

    ensure(name, "string").and(next, "function");

    if (!req.template) return next();

    var blog = req.blog;
    var templateID = req.template.id;

    // We have a special case for Cloudflare
    // because some of their SSL settings insist on fetching
    // from the origin server (in this case Blot) over HTTP
    // which causes mixed-content warnings.
    var fromCloudflare =
      Object.keys(req.headers || {})
        .map((key) => key.trim().toLowerCase())
        .find((key) => key.startsWith("cf-")) !== undefined;

    if (callback) callback = callOnce(callback);

    getCachedFullView(
      { blog: blog, template: req.template, viewName: name },
      function (err, response) {
        if (err) {
          return next(err);
        }

        if (!response) {
          err = new Error(
            `The view '${name}' does not exist under templateID=${templateID}`
          );
          err.code = "NO_VIEW";
          return next(err);
        }

        req.log("Loaded view");

        var viewLocals = response[0];
        var viewPartials = response[1];
        var missingLocals = response[2];
        var viewType = response[3];
        var view = response[4];
        var query = Object.keys(req.query).length ? { query: req.query } : {};

        extend(res.locals)
          .and(query)
          .and(viewLocals)
          .and(req.template.locals)
          .and(blog.locals);

        extend(res.locals.partials).and(viewPartials);

        retrieve(req, res, missingLocals, function (err, foundLocals) {
          extend(res.locals).and(foundLocals);

        // LOAD ANY LOCALS OR PARTIALS
        // WHICH ARE REFERENCED IN LOCALS
        loadView(req, res, function (err, req, res) {
          if (err) return next(ERROR.BAD_LOCALS());

          // VIEW IS ALMOST FINISHED
          // ALL PARTRIAL
          renderLocals(req, res, async function (err, req, res) {
            if (err) return next(ERROR.BAD_LOCALS());

            req.log("Loaded other locals");

            var output;

            var locals = res.locals;
            var partials = res.locals.partials;

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

            try {
              output = finalRender(view, locals, partials);
            } catch (e) {
              return next(ERROR.BAD_LOCALS());
            }

            // Replace protocol of CDN links for requests served over HTTP
            if (
              viewType.indexOf("text/") > -1 &&
              req.protocol === "http" &&
              fromCloudflare === false &&
              output.indexOf(config.cdn.origin) > -1
            )
              output = output
                .split(config.cdn.origin)
                .join(config.cdn.origin.split("https://").join("http://"));

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
            if (
              CACHE &&
              !req.preview &&
              (viewType === STYLE || viewType === JS)
            ) {
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
          });
        });
        });
      }
    );
  }
};
