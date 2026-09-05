var express = require("express");
var site = express.Router();
var load = require("./load");
var save = require("./save");
var trace = require("helper/trace");
var flags = require("./flags");
const sse = require("helper/sse")({
  channel: (req) => `sync:status:${req.blog.id}`,
});

site.post(
  "/",
  save.redirects,
  trace("saved redirects"),
  save.format,
  trace("formated form"),
  save.flags,
  trace("saved flags"),
  save.injectTitle,
  trace("updated injectTitle options"),
  save.analytics,
  trace("saved analytics"),
  save.avatar,
  trace("saved avatar"),
  save.removeTmpFiles,
  trace("removed any tmp files"),
  save.finish
);

site.get("/", require("./load/scheduled"));

// Load the files and folders inside a blog's folder
site.get(["/", "/folder/:path(*)"], require("./folder"));
site.post("/folder/upload", require("./folder/upload"));
site.post("/folder/remove/:path(*)", require("./folder/remove"));

site.get("/folder", (req, res) => {
  // redirect to client settings page
  res.redirect(`/sites/${req.params.handle}/client`);
});

site.use("/template", require("./template"));
site.use("/delete", require("./delete"));
site.use("/import", require("./import"));
site.use("/export", require("./export"));
site.use("/domain", require("./domain"));
site.use("/client", require("./client"));
site.use("/title", require("./title"));

site.use("/settings/date", require("./date"));
site.use("/settings/links", load.plugins, require("./link-format"));

site.get("/status", sse);

// allow the download of files directly
site.use("/folder-download/:path(*)", require("./folder/download"));

site.get("/", require("dashboard/site/load/client"), (req, res) => {
  res.render("dashboard/site", {
    title: req.blog.pretty.label,
  });
});

site.use("/settings", (req, res, next) => {
  res.locals.breadcrumbs.add("Settings", "settings");
  next();
});

site.get("/settings", load.plugins,  (req, res) => {
  res.render("dashboard/site/settings");
});

site.get("/settings/images", load.plugins,  (req, res) => {
  res.render("dashboard/site/settings/images");
});

site.get("/settings/embeds", load.plugins, (req, res) => {
  res.render("dashboard/site/settings/embeds");
});

site.get("/settings/services", load.plugins, (req, res) => {
  res.render("dashboard/site/settings/services");
});

site.get(
  "/settings/redirects",
  load.redirects,
  load.redirectWarnings,
  (req, res) => {
    res.render("dashboard/site/settings/redirects");
  }
);

site.get("/settings/flags", flags.get);

site
  .route("/settings/redirects/404s")
  .get(load.fourOhFour, function (req, res) {
    res.locals.breadcrumbs.add("Redirects", "redirects");
    res.locals.breadcrumbs.add("404 log", "404s");
    res.render("dashboard/site/settings/redirects/404s");
  })
  .post(require("./save/404"));

site.route("/settings/redirects/bulk").get(load.redirects, function (req, res) {
  res.locals.breadcrumbs.add("Redirects", "redirects");
  res.locals.breadcrumbs.add("Bulk editor", "bulk");
  res.render("dashboard/site/settings/redirects/bulk");
});

module.exports = site;
