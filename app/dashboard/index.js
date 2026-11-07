const trace = require("helper/trace");
const config = require("config");
const express = require("express");
const { LRUCache } = require("lru-cache");
const message = require("dashboard/util/message");
const cookieParser = require("cookie-parser");
const moment = require("moment");
const syncSummary = require("dashboard/util/sync-summary");
const Blog = require("models/blog");
const getStatuses = Blog.getStatuses;
const formatDashboardDate = require("dashboard/util/format-dashboard-date");

// The latest status is stored on the blog itself; only read the status log
// when that is not a "Synced" message, a page at a time.
// A site that is syncing or failed has to look back through its status log
// for the last "Synced". That can't change until a new status is written,
// which changes the blog's stored status, so the answer is cached on it.
const lastSyncedCache = new LRUCache({ max: 5000 });

async function findLastSynced(blog) {
  if (blog.status && blog.status.message === "Synced") return blog.status;

  const status = blog.status || {};
  const key = blog.id + ":" + status.datestamp + ":" + status.message;
  if (lastSyncedCache.has(key)) return lastSyncedCache.get(key);

  let found = null;
  for (let page = 1; page <= 20; page++) {
    const { statuses, next } = await getStatuses(blog.id, {
      page,
      pageSize: 100,
    });
    found = statuses.find((status) => status.message === "Synced") || null;
    if (found || !next) break;
  }

  lastSyncedCache.set(key, found);
  return found;
}

const dashboard = express.Router();
const logout = require("dashboard/account/util/logout");
const parseAuth = require("dashboard/util/parse-auth");
const parseMultipart = require("dashboard/util/multipart")();

dashboard.use(trace("loading session information"));
dashboard.use(require("dashboard/util/session"));
dashboard.use(trace("loaded session information"));

dashboard.use(cookieParser());

// Authentication forms contain only short text fields. Parse them with a
// small body limit, and skip the 30 MB multipart parser so a missed nginx
// location cannot turn these unauthenticated routes into upload endpoints.
dashboard.use(parseAuth.AUTH_FORM_PATHS, parseAuth);
dashboard.use(function skipAuthFormUploads(req, res, next) {
  if (parseAuth.isAuthFormPath(req.path)) return next();
  return parseMultipart(req, res, next);
});
dashboard.use(require("dashboard/util/parse"));
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
dashboard.use(require("dashboard/util/require-authentication"));

dashboard.use((req, res, next) => {
  const isAccount = req.path.startsWith("/account");
  const isSupport = req.path === "/support";
  res.locals.selected = {
    dashboard: "selected",
    sites: isAccount || isSupport ? "" : "is-active",
    account: isAccount ? "is-active" : "",
    support: isSupport ? "is-active" : "",
  };
  // A plain value for the layout's <body class> (site pages add to it)
  res.locals.bodyClass = "dashboard-page";
  // aria-current values for the sidebar links (a plain value, not a section,
  // so it can sit inside an attribute)
  res.locals.ariaCurrent = {
    sites: isAccount || isSupport ? "" : "page",
    account: isAccount ? "page" : "",
    support: isSupport ? "page" : "",
  };
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

dashboard.get("/support", (req, res) => {
  res.locals.title = "Support";
  res.locals.breadcrumbs.add("Support", "/sites/support");
  res.render("dashboard/support");
});

// These need to be before ':handle'
dashboard.use("/account", require("./account"));

dashboard.use(
  "/share-template",
  require("dashboard/util/load-blogs"),
  require("./site/template/share-template")
);

// Live sync messages for the Sites list, one stream for every site
dashboard.get(
  "/status",
  require("dashboard/util/load-blogs").basic,
  require("dashboard/util/sites-status-stream")
);

// The Sites list's text comparisons, as the browser's localeCompare(..., {
// numeric: true, sensitivity: "base" }) makes them; one collator for all
const sitesCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

dashboard.get("/", require("dashboard/util/load-blogs"), async (req, res) => {
  const blogs = req.blogs || [];
  res.locals.siteCount = blogs.length;
  res.locals.siteCountNoun = blogs.length === 1 ? "site" : "sites";
  await Promise.all(
    blogs.map(async (blog) => {
      let lastPublishedStatus = null;
      try {
        lastPublishedStatus = await findLastSynced(blog);
      } catch (error) {}

      const datestamp = lastPublishedStatus && lastPublishedStatus.datestamp;
      if (datestamp) {
        const publishedAt = moment(datestamp);
        blog.lastPublished = formatDashboardDate(datestamp, blog.timeZone);
        blog.lastPublishedDatetime = publishedAt.toISOString();
        blog.lastPublishedTimestamp = datestamp;
      } else {
        blog.lastPublished = "—";
        blog.lastPublishedDatetime = "";
        blog.lastPublishedTimestamp = null;
      }

      // The Sync column: the last sync's time, or what is happening now
      // (js/sites-sync.js keeps it live)
      const sync = syncSummary(blog);
      blog.sync = {
        state:
          sync.state === "syncing"
            ? "syncing"
            : sync.state === "error"
              ? "error"
              : blog.client
                ? "synced"
                : "off",
        isSyncing: sync.state === "syncing",
        text: sync.state === "syncing" ? sync.text || sync.label : "",
        count: sync.count || "",
        progressClass: sync.progress === undefined ? "" : "has-progress",
        progressStyle:
          sync.progress === undefined ? "" : `--progress: ${sync.progress}%`,
      };
    })
  );

  // Listed in the order the user last sorted the table by, kept in the
  // sites-sort cookie by js/data-table.js, so the browser has nothing to
  // reorder. The comparisons match the browser's.
  const compareText = (a, b) => sitesCollator.compare(String(a), String(b));
  const sortValues = {
    name: (blog) => blog.pretty.label,
    domain: (blog) => blog.pretty.url,
    lastPublished: (blog) => blog.lastPublishedTimestamp || -Infinity,
  };
  const [cookieSort, cookieOrder] = String(
    (req.cookies && req.cookies["sites-sort"]) || ""
  ).split(".");
  // Own keys only: "hasOwnProperty" or "__proto__" would reach the object's
  // prototype and throw in the sort
  const sort = Object.hasOwn(sortValues, cookieSort) ? cookieSort : "name";
  const order = cookieOrder === "desc" ? "desc" : "asc";
  const direction = order === "desc" ? -1 : 1;

  blogs.sort((a, b) => compareText(a.pretty.label, b.pretty.label));
  if (sort !== "name" || order !== "asc") {
    const value = sortValues[sort];
    blogs.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const result =
        sort === "lastPublished"
          ? x === y
            ? 0
            : x < y
              ? -1
              : 1
          : compareText(x, y);
      return result * direction;
    });
  }
  // No cookie is the default order, which shows no arrow
  res.locals.sitesSort = Object.hasOwn(sortValues, cookieSort) ? sort : "";
  res.locals.sitesOrder = order;

  res.locals.title = "Sites";
  res.locals.breadcrumbs.add("Sites", "/sites");
  res.render("dashboard");
});

// /sites/default/<path> redirects to the last-used site (or first site) + path.
// "default" is a reserved handle (see models/blog/validate/banned.txt).
dashboard.use(
  "/default",
  require("dashboard/util/load-blogs").basic,
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

// Redis unreachable: respond 503. This must come before the handler below,
// which would turn the failure into a flash message and a redirect.
dashboard.use(require("helper/redisUnavailable").redisUnavailableHandler);

// need to handle dashboard errors better...
dashboard.use(message.errorHandler);

dashboard.use(function (req, res, next) {
  const err = new Error("Page not found");
  err.status = 404;
  next(err);
});

// Some kind of other error
// jshint unused:false
const renderError = require("dashboard/util/render-error");
dashboard.use(function (err, req, res, next) {
  // If the user is not logged in, we sent them to the documentation
  if (err.message === "NOUSER") {
    // An EventSource (e.g. the sync-status stream on a site's folder page)
    // can't usefully follow a redirect to the log-in page: browsers treat
    // the redirect target as the stream's new URL, and our reconnecting
    // client retries indefinitely, so a session expiring while a tab is
    // left open turns into a permanent loop of requests to /log-in. Fail
    // with a plain 401 on the same URL instead, so any retries stay on
    // this cheap, authenticated endpoint rather than spilling onto /log-in.
    if (req.headers.accept === "text/event-stream") {
      return res.sendStatus(401);
    }

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

  if (config.environment === "development") {
    res.locals.error = {
      stack: err.stack,
    };
  }

  console.error(err.message);
  console.error(err.stack);

  renderError(err, req, res);
});

module.exports = dashboard;
