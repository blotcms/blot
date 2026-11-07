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

function getSidebarSelection(path) {
  // The overview and everything it leads to (all files, a file or
  // subfolder, posts, recent activity, folder settings) are under Folder
  if (
    path === "/" ||
    path === "/files" ||
    path === "/search" ||
    path === "/activity" ||
    path === "/recents" ||
    path === "/posts" ||
    path.startsWith("/posts/") ||
    path === "/pages" ||
    path === "/drafts" ||
    path === "/scheduled" ||
    path.startsWith("/folder/") ||
    path === "/sync" ||
    path.startsWith("/sync/")
  )
    return "folder";
  if (path === "/settings" || path.startsWith("/settings/"))
    return "siteSettings";
  if (
    path === "/template" ||
    path.startsWith("/template/") ||
    path.startsWith("/template-folder")
  )
    return "template";
  if (path.startsWith("/import")) return "import";
  return null;
}

// What the phone navigation bar shows as the current section
const sidebarLabels = {
  folder: "Folder",
  template: "Template",
  siteSettings: "Settings",
  import: "Import",
};

// Every page has a title of its own: a page that doesn't set one (or sets
// just the site's name) is named after its last breadcrumb, e.g.
// "Settings · David - Blot". The overview keeps the site's name.
site.use((req, res, next) => {
  const render = res.render.bind(res);
  res.render = (view, options, callback) => {
    const label = req.blog && req.blog.pretty && req.blog.pretty.label;
    const crumbs = res.locals.breadcrumbs || [];
    const opts = typeof options === "object" && options ? options : null;
    const current = (opts && opts.title) || res.locals.title;
    if (label && crumbs.length > 2 && (!current || current === label)) {
      const title = crumbs[crumbs.length - 1].label + " · " + label;
      res.locals.title = title;
      if (opts) opts.title = title;
    }
    return render(view, options, callback);
  };
  next();
});

site.use((req, res, next) => {
  const path = req.path.replace(/\/$/, "") || "/";
  const selectedItem = getSidebarSelection(path);

  if (selectedItem) {
    res.locals.selected = {
      ...res.locals.selected,
      [selectedItem]: "is-active",
    };
    res.locals.ariaCurrent = { [selectedItem]: "page" };
    res.locals.currentSectionLabel = sidebarLabels[selectedItem];
  }

  res.locals.siteDashboardSidebarClass =
    "dashboard-sidebar dashboard-sidebar--site";

  next();
});

// The sidebar's site switcher lists the user's sites on every page. It only
// needs each one's name and address, so it reads those three fields for
// every site, sent together, rather than loading each site in full. Only
// for pages, not the status stream, image redirects or other non-HTML
// requests.
const config = require("config");
const client = require("models/client");
const blogKey = require("models/blog/key");
const punycode = require("helper/punycode");

async function loadSwitcherBlogs(req, res) {
  const ids = (req.user && req.user.blogs) || [];
  // Separate commands, not a MULTI: node-redis pipelines them, and the
  // client-side cache can answer reads of the blog's info hash (a MULTI
  // always goes to the server)
  const rows = await Promise.all(
    ids.map((id) =>
      client.hmGet(blogKey.info(id), ["handle", "title", "domain"])
    )
  );

  // The label and address as models/blog/extend.js makes them
  const blogs = [];
  rows.forEach(([handle, title, domain], i) => {
    if (!handle) return;
    const url = domain
      ? punycode.toUnicode(domain)
      : handle + "." + config.host;
    blogs.push({
      id: ids[i],
      handle,
      title,
      pretty: { url, label: title || url },
    });
  });
  req.blogs = res.locals.blogs = blogs;
}
const syncSummary = require("dashboard/util/sync-summary");
// One collator, not one per comparison (localeCompare with options builds one
// each time)
const byName = new Intl.Collator(undefined, { sensitivity: "base" });

site.use((req, res, next) => {
  if (req.method !== "GET" || !req.accepts("html")) return next();

  // The sync status at the top right of the page, from the status and
  // health already loaded with the blog
  const sync = syncSummary(req.blog);
  res.locals.globalSync = {
    ...sync,
    title: sync.title || sync.label,
    text: sync.text || sync.label,
    count: sync.count || "",
    progressClass: sync.progress === undefined ? "" : "has-progress",
    progressStyle:
      sync.progress === undefined ? "" : `--progress: ${sync.progress}%`,
    url:
      sync.state === "off"
        ? `${res.locals.base}/sync`
        : `${res.locals.base}/activity`,
  };

  // The state class js/sync_status.js gives the folder pages' status line
  // (clients/sync-status.html), from the same text, so its icon is right
  // in the first paint
  const statusText = req.blog.healthIssue
    ? req.blog.healthIssue.label || ""
    : (req.blog.status && req.blog.status.message) || "";
  res.locals.syncStatusClass = statusText.startsWith("Synced")
    ? "synced"
    : statusText.startsWith("Error")
      ? "error"
      : "syncing";

  loadSwitcherBlogs(req, res).then(() => {
    // In name order, like the Sites list
    (res.locals.blogs || []).sort((a, b) =>
      byName.compare(a.pretty.label, b.pretty.label)
    );
    (res.locals.blogs || []).forEach((blog) => {
      blog.isCurrent = blog.id === req.blog.id;
      // Plain values for the switcher's attributes (no sections in attributes)
      blog.switcherClass = blog.isCurrent
        ? "site-switcher__site is-current"
        : "site-switcher__site";
      blog.ariaCurrent = blog.isCurrent ? "page" : "";
    });
    next();
  }, next);
});

// Each filter of the Posts page has its own URL: /posts, /pages, /drafts
// and /scheduled
const postFilterLabels = {
  posts: "Posts",
  pages: "Pages",
  drafts: "Drafts",
  scheduled: "Scheduled",
};

// Each view only loads the data it renders
const setView = (view) => (req, res, next) => {
  const filter = view === "posts" ? req.path.slice(1) : "all";

  res.locals.dashboardView = view;
  res.locals.pageHeading = {
    folder: "Overview",
    recent: "Activity",
    posts: postFilterLabels[filter],
    search: "Search results",
  }[view];
  res.locals.showPageHeading = view === "recent";
  res.locals.dashboardFilter = view === "posts" ? filter : "all";
  res.locals.isFolderView = view === "folder";
  res.locals.isOverviewView = view === "folder";
  res.locals.isRecentView = view === "recent";
  res.locals.isPostsView = view === "posts";
  res.locals.isSearchView = view === "search";
  // Posts, pages, drafts and scheduled are the folder filtered by its pills
  res.locals.showPostsPanel = view === "posts";
  res.locals.showDashboardSearch =
    view === "folder" || view === "search" || view === "posts";
  res.locals.dashboardViewClass = [
    "collapse-on-small-screens site-dashboard",
    res.locals.isFolderView && "is-folder-view",
    res.locals.isOverviewView && "is-overview-view",
    res.locals.isRecentView && "is-recent-view",
    res.locals.isSearchView && "is-search-view",
    res.locals.isPostsView && "is-posts-view",
  ]
    .filter(Boolean)
    .join(" ");

  if (view === "recent") res.locals.breadcrumbs.add("Activity", "activity");
  if (view === "search") res.locals.breadcrumbs.add("Search", "search");

  // The filters are views of the folder box, so they keep the site's
  // breadcrumbs, as its tabs do

  next();
};

// Each page names itself before the site, e.g. "Drafts · David - Blot"
const renderDashboard = (req, res) => {
  res.render("dashboard/site", {
    title: res.locals.isOverviewView
      ? req.blog.pretty.label
      : res.locals.pageHeading + " · " + req.blog.pretty.label,
    bodyClass: "dashboard-page site-dashboard-page",
  });
};

site.get(
  "/",
  setView("folder"),
  require("./folder"),
  require("./load/posts"),
  require("./load/live-template"),
  loadClient,
  renderDashboard
);
// The overview lists every file now, so the separate Files page went
site.get("/files", (req, res) => {
  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.redirect(302, `${res.locals.base}${query}`);
});
// The page was at /recents
site.get("/recents", (req, res) => {
  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.redirect(302, `${res.locals.base}/activity${query}`);
});
site.get(
  "/activity",
  setView("recent"),
  require("./load/recent-activity"),
  loadClient,
  renderDashboard
);
site.get(
  "/search",
  setView("search"),
  require("./load/search"),
  loadClient,
  renderDashboard
);
// The filters were at /posts/pages and so on
site.get("/posts/:filter", (req, res) => {
  const filter = req.params.filter;
  res.redirect(
    302,
    `${res.locals.base}/${Object.hasOwn(postFilterLabels, filter) ? filter : "posts"}`
  );
});
site.get(
  Object.keys(postFilterLabels).map((filter) => "/" + filter),
  setView("posts"),
  require("./load/posts"),
  require("./load/live-template"),
  loadClient,
  renderDashboard
);

// Load the files and folders inside a blog's folder
const folderPaths = require("./folder/paths");

site.get(folderPaths.folder, load.client, require("./folder"));
site.post("/folder/upload", require("./folder/upload"));
site.post(folderPaths.remove, require("./folder/remove"));

site.get("/folder", (req, res) => {
  // Keep the old root folder URL pointed at the combined Folder view.
  res.redirect(res.locals.base);
});

const templateEditor = require("./template");
site.use("/template", (req, res, next) => {
  res.locals.breadcrumbs.add("Template", "template");
  next();
});
site.use("/template", templateEditor);
// A template the blog has moved into its local editing folder is reachable
// at the same slug under /template-folder/ too (see templates.js, which
// links a row's editURL through whichever of these two mounts applies to
// it) — mounting the same router twice means every existing route, save
// handler and redirect under app/dashboard/site/template/ works the same
// way regardless of which prefix was used to reach it, since express.Router
// sets req.baseUrl to whichever one actually matched.
site.use("/template-folder", templateEditor);
// Delete site is the last Settings tab; the old addresses lead there, and a
// form still posting to /delete still works
site.get(["/delete", "/delete/confirm"], (req, res) => {
  res.redirect(
    302,
    `${res.locals.base}/settings${req.originalUrl.slice(req.originalUrl.indexOf("/delete"))}`
  );
});
site.use("/delete", require("./delete"));
site.use("/import", require("./import"));
// Export is a Settings tab; the old page leads there, and its download
// links keep working
site.get("/export", (req, res) => {
  res.redirect(302, `${res.locals.base}/settings/export`);
});
site.use("/export", require("./export"));
const domain = require("./domain");
const title = require("./title");

const dateSettings = require("./date");
const linkFormat = require("./link-format");

site.get("/status", sse);

// The stored sync status, which js/global-sync.js reads when its stream opens
// (the stream only sends what is published after that)
site.get("/sync-status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    message: (req.blog.status && req.blog.status.message) || "Synced",
  });
});

// allow the download of files directly
site.use(folderPaths.download, require("./folder/download"));

site.use("/settings", (req, res, next) => {
  res.locals.breadcrumbs.add("Settings", "settings");
  next();
});

// The sync pages (the folder's client and its options) were under
// /settings/folder; old links and bookmarks keep working
site.use("/settings/folder", (req, res) => {
  const suffix = req.url === "/" ? "" : req.url;
  res.redirect(308, `${res.locals.base}/sync${suffix}`);
});
site.use("/sync", require("./client"));

// Keep old dashboard bookmarks working while the folder settings move under
// the Settings section. These paths are dashboard routes; provider callbacks
// and public client endpoints are mounted elsewhere.
// Except provider OAuth callbacks: the proxy pins /client/:client/authenticate
// to its own upstream (proxy/config/blot-site.conf) because the callback
// starts the first full sync, so serve them here rather than redirecting.
const clientSettings = require("./client");
site.use("/client", (req, res, next) => {
  if (/^\/[^/]+\/authenticate(\/|$)/.test(req.path)) {
    return clientSettings(req, res, next);
  }
  const suffix = req.url === "/" ? "" : req.url;
  res.redirect(308, `${res.locals.base}/sync${suffix}`);
});

// The title and domain pages also moved under Settings
for (const page of ["title", "domain"]) {
  site.use("/" + page, (req, res) => {
    const suffix = req.url === "/" ? "" : req.url;
    res.redirect(308, `${res.locals.base}/settings/${page}${suffix}`);
  });
}

// The Settings page: one tab per group of settings, each its own page
// Title and Domain are settings too, first since they're the most used
const settingsTabs = [
  ["title", "Title"],
  ["domain", "Domain"],
  ["posts", "Posts"],
  ["redirects", "Redirects"],
  ["services", "Services"],
  ["export", "Export"],
  ["delete", "Delete site"],
];

const settingsTab = (tab) => (req, res, next) => {
  res.locals.settingsTabs = settingsTabs.map(([slug, label]) => ({
    label,
    url: `${res.locals.base}/settings/${slug}`,
    current: slug === tab ? "page" : "",
  }));
  next();
};

site.use("/settings/title", settingsTab("title"), title);
site.use("/settings/export", settingsTab("export"), require("./export"));
site.use("/settings/delete", settingsTab("delete"), require("./delete"));
site.use("/settings/domain", settingsTab("domain"), domain);

const settingsRedirect = (to) => (req, res) => {
  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.redirect(302, `${res.locals.base}/settings/${to}${query}`);
};

// The first tab
site.get("/settings", settingsRedirect("title"));

// Earlier versions of these pages: Writing, Date and time, Images and Links
// are sections of Posts; Integrations is Services. A URLs tab briefly held
// the link format and redirects.
site.get("/settings/content", settingsRedirect("posts"));
site.get("/settings/writing", settingsRedirect("posts"));
site.get("/settings/images", settingsRedirect("posts#image-features-heading"));
site.get("/settings/links", settingsRedirect("posts#post-links-heading"));
site.get("/settings/urls", settingsRedirect("redirects"));
site.get("/settings/integrations", settingsRedirect("services"));
site.get("/settings/embeds", settingsRedirect("services"));
site.get("/settings/date", settingsRedirect("posts#date-heading"));

// How Blot builds posts: formatting, dates, their URLs, links in them,
// images
site.get(
  "/settings/posts",
  settingsTab("posts"),
  load.plugins,
  dateSettings.loadSettings,
  linkFormat.loadFormats,
  (req, res) => {
    res.locals.publishImagesAsPostsChecked = req.blog.isImgConverterEnabled
      ? "checked"
      : "";
    res.locals.imageConverterPluginClass = req.blog.isImgConverterEnabled
      ? "checked"
      : "";
    res.locals.imageExifOffChecked = req.blog.isImageExifOff ? "checked" : "";
    res.locals.imageExifBasicChecked = req.blog.isImageExifBasic
      ? "checked"
      : "";
    res.locals.imageExifFullChecked = req.blog.isImageExifFull ? "checked" : "";
    res.render("dashboard/site/settings/settings-posts");
  }
);

// The 404 log links here with ?create=<path> to prefill a redirect
site.get(
  "/settings/redirects",
  settingsTab("redirects"),
  load.redirects,
  load.redirectWarnings,
  (req, res) => {
    res.render("dashboard/site/settings/settings-redirects");
  }
);

// The link format, on Posts, saves here
site.post("/settings/links", linkFormat.save);
site.post("/settings/urls", linkFormat.save);

site.get(
  "/settings/services",
  settingsTab("services"),
  load.plugins,
  (req, res) => {
    res.render("dashboard/site/settings/services");
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
