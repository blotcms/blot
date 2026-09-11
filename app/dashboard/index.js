const trace = require("helper/trace");
const config = require("config");
const express = require("express");
const message = require("dashboard/util/message");
const cookieParser = require('cookie-parser');

const dashboard = express.Router();
const logout = require("dashboard/account/util/logout");

dashboard.use(trace("loading session information"));
dashboard.use(require("dashboard/util/session"));
dashboard.use(trace("loaded session information"));

dashboard.use(require("dashboard/util/multipart")());

dashboard.use(require("dashboard/util/parse"));
dashboard.use(cookieParser());
dashboard.use(require("dashboard/util/csrf"));

// These need to be accessible to unauthenticated users
dashboard.use("/sign-up", require("./sign-up"));
dashboard.use("/log-in", require("./log-in"));

dashboard.get("/disabled", logout, (req, res) => {
  res.render("dashboard/disabled");
});

dashboard.get("/deleted", logout, (req, res) => {
  res.render("dashboard/deleted");
});

// Everything afterwards should be authenticated
dashboard.use(require('dashboard/util/require-authentication'));

dashboard.use((req, res, next)=>{
  res.locals.selected = { dashboard: "selected" };
  next();
});

dashboard.use(message.middleware);

dashboard.use(trace("loading user"));
dashboard.use(require("dashboard/util/load-user"));
dashboard.use(trace("loaded user"));

dashboard.use(trace("loading blog"));
dashboard.param("handle", require("dashboard/util/load-blog"));
dashboard.use(trace("loaded blog"));

dashboard.use(require("dashboard/util/breadcrumbs"));

// These need to be before ':handle'
dashboard.use("/account", require("./account"));

dashboard.use(
  "/share-template",
  require("dashboard/util/load-blogs"),
  require("./site/template/share-template")
);

dashboard.get("/", require("dashboard/util/load-blogs"), async (req, res) => {
  res.locals.title = "Sites";
  res.locals.breadcrumbs.add("Sites", "/sites");
  res.render("dashboard");
});

// /sites/default/<path> redirects to the last-used site (or first site) + path.
// "default" is a reserved handle (see models/blog/validate/banned.txt).
dashboard.use(
  "/default",
  require("dashboard/util/load-blogs"),
  (req, res, next) => {
    if (!req.blogs || !req.blogs.length) return next();
    const chosen =
      req.session.lastBlogHandle &&
      req.blogs.some((b) => b.handle === req.session.lastBlogHandle)
        ? req.session.lastBlogHandle
        : req.blogs[0].handle;
    // When mounted at "/default", Express strips the prefix so req.path is e.g. "/title" or ""
    const pathSuffix = req.path || "";
    res.redirect(`/sites/${chosen}${pathSuffix}`);
  }
);

dashboard.use("/:handle", require("./site"));

// This will catch old links to the dashboard before
// we encoded the blog's username in the URLs
dashboard.use(require("dashboard/util/redirect-to-other-blog"));

// need to handle dashboard errors better...
dashboard.use(message.errorHandler);

dashboard.use(function (req, res, next) {
  const err = new Error("Page not found");
  err.status = 404;
  next(err);
});

// Some kind of other error
// jshint unused:false
dashboard.use(function (err, req, res, next) {
  // If the user is not logged in, we sent them to the documentation
  if (err.message === "NOUSER") {
    let from;
    try {
      let referrer = require("url").parse(req.get("Referrer"));
      if (referrer.host === config.host) from = referrer.path;
    } catch (e) {}

    res.clearCookie("signed_into_blot", { domain: "", path: "/" });
    return res.redirect(
      "/log-in?then=" + req.originalUrl + (from ? "&from=" + from : "")
    );
  }

  const status = err.status || 400;

  if (config.environment === "development") {
    res.locals.error = {
      stack: err.stack
    };
  }

  console.error(err.message);
  console.error(err.stack);

  res.locals.layout = "";
  res.status(status);
  res.render("error");
});

module.exports = dashboard;
