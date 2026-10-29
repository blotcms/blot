var express = require("express");
var site = express.Router();

// N.B. In production a GET/HEAD to /sites/:handle/... is served by blue but any
// other method (POST etc.) is served by green - see $dashboard_upstream in
// proxy/config/http.conf. A page load right after a save can therefore
// run in a different process from the write, so in-process caches (LRUs,
// memoized lookups) can be stale across the redirect. Key caches on something
// stored in Redis (e.g. blog.cacheID, which sync bumps, as the folder caches do)
// rather than relying on in-process invalidation. Sessions, CSRF and Redis reads
// are already safe across containers. The /import routes are the exception: they
// run entirely on green because import state lives in per-container temp files.
// A GET that mutates or does heavy work (e.g. the Dropbox OAuth callback) stays on
// blue unless pinned: make it a POST, or add a location in blot-site.conf.
var load = require("./load");
var save = require("./save");
var trace = require("helper/trace");
var flags = require("./flags");
var loadClient = require("dashboard/site/load/client");
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

const postFilters = new Set(["posts", "pages", "drafts", "scheduled"]);
const postFilterLabels = {
  posts: "Published",
  pages: "Pages",
  drafts: "Drafts",
  scheduled: "Scheduled",
};

// Each view only loads the data it renders
const setView = (view) => (req, res, next) => {
  const filter = req.params.filter || "all";

  if (view === "posts" && filter !== "all" && !postFilters.has(filter)) {
    return res.redirect(`${res.locals.base}/posts`);
  }

  res.locals.dashboardView = view;
  res.locals.dashboardFilter = view === "posts" ? filter : "all";
  res.locals.isFolderView = view === "folder";
  res.locals.isRecentView = view === "recent";
  res.locals.isPostsView = view === "posts";
  res.locals.isAllPostsFilter = res.locals.dashboardFilter === "all";

  if (view === "recent") res.locals.breadcrumbs.add("Recents", "recents");

  if (view === "posts") {
    res.locals.breadcrumbs.add("Posts", "posts");
    if (filter !== "all") {
      res.locals.breadcrumbs.add(postFilterLabels[filter], filter);
    }
  }

  next();
};

const renderDashboard = (req, res) => {
  res.render("dashboard/site", {
    title: req.blog.pretty.label,
  });
};

site.get("/", setView("folder"), require("./folder"), loadClient, renderDashboard);
site.get(
  "/recents",
  setView("recent"),
  require("./load/recent-activity"),
  loadClient,
  renderDashboard
);
site.get(
  ["/posts", "/posts/:filter"],
  setView("posts"),
  require("./load/posts"),
  loadClient,
  renderDashboard
);

// Load the files and folders inside a blog's folder
site.get("/folder/:path(*)", load.client, require("./folder"));
site.post("/folder/upload", require("./folder/upload"));
site.post("/folder/remove/:path(*)", require("./folder/remove"));

site.get("/folder", (req, res) => {
  // redirect to client settings page
  res.redirect(`/sites/${req.params.handle}/settings/folder`);
});

const templateEditor = require("./template");
site.use("/template", templateEditor);
// A template the blog has moved into its local editing folder is reachable
// at the same slug under /template-folder/ too (see templates.js, which
// links a row's editURL through whichever of these two mounts applies to
// it) — mounting the same router twice means every existing route, save
// handler and redirect under app/dashboard/site/template/ works the same
// way regardless of which prefix was used to reach it, since express.Router
// sets req.baseUrl to whichever one actually matched.
site.use("/template-folder", templateEditor);
site.use("/delete", require("./delete"));
site.use("/import", require("./import"));
site.use("/export", require("./export"));
const domain = require("./domain");
const title = require("./title");

site.use("/settings/date", require("./date"));
site.use("/settings/links", load.plugins, require("./link-format"));

site.get("/status", sse);

// allow the download of files directly
site.use("/folder-download/:path(*)", require("./folder/download"));

site.use("/settings", (req, res, next) => {
  res.locals.breadcrumbs.add("Settings", "settings");
  next();
});

site.use("/settings/folder", require("./client"));

// Keep old dashboard bookmarks working while the folder settings move under
// the Settings section. These paths are dashboard routes; provider callbacks
// and public client endpoints are mounted elsewhere.
site.use("/client", (req, res) => {
  const suffix = req.url === "/" ? "" : req.url;
  res.redirect(308, `${res.locals.base}/settings/folder${suffix}`);
});

// The title and domain pages also moved under Settings
for (const page of ["title", "domain"]) {
  site.use("/" + page, (req, res) => {
    const suffix = req.url === "/" ? "" : req.url;
    res.redirect(308, `${res.locals.base}/settings/${page}${suffix}`);
  });
}

site.use("/settings/title", title);
site.use("/settings/domain", domain);

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
