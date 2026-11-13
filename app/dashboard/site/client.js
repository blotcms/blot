const clients = require("clients");
const syncSummary = require("dashboard/util/sync-summary");
const express = require("express");
const client_routes = express.Router();
const Blog = require("models/blog");
const load = require("./load");
const Sync = require("sync");
const Fix = require("sync/fix");
const Rebuild = require("sync/rebuild");
const config = require("config");
const fetch = require("node-fetch");
const notifyAdminIfResyncFoundChanges = require("./notifyResyncFoundChanges");
const syncReport = require("clients/util/syncReport");
const storage = require("storage/folder");
const fileFlags = require("models/file/flags");

const RESYNC_REFUSALS = [
  "DROPBOX_TRANSFER_INCOMPLETE",
  "GOOGLE_DRIVE_FOLDER_MISSING",
  "ICLOUD_FOLDER_MISSING",
  "ICLOUD_SETUP_INCOMPLETE",
];

// A connected folder's sync pages: Resync sits beside the status, for the
// clients that can, and hides while the folder syncs (so once it's clicked)
client_routes.get(/.*/, function (req, res, next) {
  if (!req.blog.client) return next();
  res.locals.canResync = !!(
    clients[req.blog.client] && clients[req.blog.client].resync
  );
  res.locals.isSyncing = syncSummary(req.blog).state === "syncing";
  // The client's own page, headed with its logo and name; its subpages
  // have headings of their own
  res.locals.isClientPage =
    req.path.replace(/\/$/, "") === "/" + req.blog.client;
  next();
});

// The sync pages, at /sites/<handle>/sync. Breadcrumbs: Sites > Site > Sync
client_routes.use(function (req, res, next) {
  res.locals.base = req.baseUrl;
  res.locals.isFolderSettingsView = true;
  res.locals.breadcrumbs.add("Sync", "sync");
  next();
});

client_routes.use(load.client);

client_routes

  .route("/switch")

  .get(load.clients, function (req, res) {
    const activeClient = req.blog.client || res.locals.effectiveClient;

    // filter current client from list of clients
    res.locals.clients = JSON.parse(JSON.stringify(res.locals.clients)).filter(
      (client) => {
        return client.name !== activeClient;
      }
    );

    res.locals.breadcrumbs.add("Switch", "switch");

    // ?to=<client> asks the user to confirm before the POST below
    // disconnects the current client
    const target = res.locals.clients.find((c) => c.name === req.query.to);

    res.render("dashboard/clients/switch", {
      title: "Switch to another client",
      confirm: target || false,
    });
  })

  .post(async function (req, res, next) {
    const redirect = req.baseUrl + "/" + req.body.client;

    // A client Blot has, by name (own keys only)
    if (!req.body.client || !Object.hasOwn(clients, req.body.client)) {
      return next(new Error("Please select a client"));
    }

    if (req.body.client === req.blog.client) return res.redirect(redirect);

    try {
      await clients[req.blog.client].disconnect(req.blog.id);
      await Blog.set(req.blog.id, { client: req.body.client });

      res.redirect(redirect);
    } catch (err) {
      next(err);
    }
  });

// The sync log moved to the site's Activity page
client_routes.get("/activity", function (req, res) {
  const query = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
    : "";
  res.redirect(302, res.locals.dashboardBase + "/activity" + query);
});

client_routes

  .route("/reset")

  .get(load.client, function (req, res) {
    res.locals.breadcrumbs.add("Reset", "reset");
    res.render("dashboard/clients/reset", {
      title: "Reset your folder",
    });
  });

// N.B. these reset POSTs run on green, the redirect target renders on blue;
// see dashboard/site/index.js.
client_routes.post("/reset/rebuild", function (req, res) {
  // Set once the sync has the lock, to tell its failure apart from a later one
  let folder = null;

  Sync(req.blog.id, async function (syncFolder) {
    folder = syncFolder;

    res.message(res.locals.base + "/reset", "Begin rebuild of your site");

    folder.status("Rebuilding your site");

    const thumbnails = !!req.query.thumbnails;
    const imageCache = !!req.query.imageCache;

    try {
      await Rebuild(req.blog.id, {
        thumbnails,
        imageCache,
        status: folder.status,
        log: folder.log,
      });
    } catch (err) {
      console.log(err);
    }

    folder.status("Checking your site for issues");

    let report;

    try {
      report = await Fix(req.blog, { status: folder.status, log: folder.log });
    } catch (err) {
      console.log(err);
      report = err.report;
    }

    // Fix() doesn't email; a rebuild only logs what it repaired.
    const repaired = syncReport.summarize(report);
    if (repaired) console.log("Fix repaired", req.blog.id, repaired);
    folder.status("Finished site rebuild");
  }).catch(function (err) {
    if (!folder) {
      return res.message(
        res.locals.base + "/reset",
        new Error("Failed to rebuild folder since it is syncing")
      );
    }

    console.log("Error releasing sync: ", err);
  });
});

client_routes.post("/reset/resync", load.client, function (req, res, next) {
  if (!res.locals.client.resync)
    return next(new Error("Cannot resync using your current client"));

  // Set once the sync has the lock, to tell its failure apart from a later one
  let folder = null;
  let refusal = null;

  Sync(req.blog.id, async function (syncFolder) {
    folder = syncFolder;

    // Back to the client's page, where the status shows it running
    res.message(
      res.locals.base + "/" + req.blog.client,
      "Begin resync of your site"
    );

    let summary;

    try {
      summary = await res.locals.client.resync(
        req.blog.id,
        folder.status,
        folder.update
      );
    } catch (err) {
      console.log("ERROR:", err);

      // A client can refuse to resync when it isn't safe or possible to:
      // Dropbox while its initial transfer to Dropbox hasn't finished
      // (clients/dropbox/sync/reset-to-blot.js), Google Drive when its
      // folder was trashed, deleted or unshared
      // (clients/google-drive/sync/resetFromDrive.js), iCloud when its folder
      // was deleted or its initial transfer hasn't finished
      // (clients/icloud/resync.js). Surface that refusal
      // instead of falling through to Fix() and "Finished site rebuild"
      // below, which would make the refusal look like a successful resync.
      if (err && RESYNC_REFUSALS.includes(err.code)) {
        // The sync publishes "Synced" as it finishes, so the refusal is
        // published again afterwards to make it the final status the user
        // sees.
        refusal = err.message;
        folder.status(refusal);
        return;
      }
    }

    folder.status("Checking your site for issues");

    let report;

    try {
      report = await Fix(req.blog, { status: folder.status, log: folder.log });
    } catch (err) {
      console.log(err);
      report = err.report;
    }

    // After Fix() so its repairs go in the same email as the changes.
    notifyAdminIfResyncFoundChanges(
      req.blog,
      res.locals.client,
      summary,
      report
    );
    folder.status("Finished site rebuild");
  }).then(
    function () {
      if (refusal) folder.status(refusal);
    },
    function (err) {
      if (!folder) {
        return res.message(
          res.locals.base + "/reset",
          new Error("Failed to resync folder since it is syncing")
        );
      }

      console.log("Error releasing sync: ", err);
      if (refusal) folder.status(refusal);
    }
  );
});

// Generic open folder route for all clients (development only)
if (config.environment === "development") {
  const DEFAULT_OPEN_FOLDER_ORIGIN =
    process.env.LOCAL_OPEN_FOLDER_ORIGIN ||
    (config.container
      ? "http://host.docker.internal:3020"
      : "http://localhost:3020");

  client_routes.get("/open", async function (req, res, next) {
    try {
      const openUrl = new URL(`${DEFAULT_OPEN_FOLDER_ORIGIN}/open-folder`);
      openUrl.searchParams.set("blogID", req.blog.id);
      // The Local client's source directory is named for the handle
      openUrl.searchParams.set("handle", req.blog.handle);

      // Include client type if available
      if (req.query.local) {
        openUrl.searchParams.set("client", "local");
      } else if (req.blog.client) {
        openUrl.searchParams.set("client", req.blog.client);
      }

      const response = await fetch(openUrl.href);

      if (!response.ok) {
        throw new Error("Request failed");
      }

      res.redirect(
        res.locals.dashboardBase +
          "/sync" +
          (req.blog.client ? "/" + req.blog.client : "")
      );
    } catch (error) {
      next(new Error("Could not open folder on your computer"));
    }
  });
}

client_routes
  .route("/")

  .get(load.clients, function (req, res) {
    // The Sync breadcrumb leads to the client's page
    if (req.blog.client) {
      return res.redirect(
        res.locals.dashboardBase + "/sync/" + req.blog.client
      );
    }

    res.render("dashboard/clients", { title: "Select a client" });
  })

  .post(function (req, res, next) {
    if (!req.body.client) {
      return next(new Error("Please select a client"));
    }

    if (clients[req.body.client] === undefined) {
      return next(new Error("Please select a client"));
    }

    return res.redirect(req.baseUrl + "/" + req.body.client);
  });

client_routes.use("/:client", function (req, res, next) {
  if (clients[req.params.client] === undefined) {
    return res.redirect(res.locals.dashboardBase + "/sync");
  }

  if (req.blog.client && req.params.client !== req.blog.client) {
    return res.redirect(res.locals.dashboardBase + "/sync/" + req.blog.client);
  }

  if (!req.blog.client) {
    const relativePath = req.path || "/";
    const allowedUnpersistedPaths = new Set([
      "/",
      "/connect",
      "/setup",
      "/set-up-folder",
      "/redirect",
      "/authenticate",
      "/create",
      "/disconnect",
    ]);

    if (!allowedUnpersistedPaths.has(relativePath)) {
      return res.redirect(res.locals.dashboardBase + "/sync");
    }
  }

  res.locals.base = req.baseUrl;
  res.locals.effectiveClient = req.params.client;

  load.client(req, res, next);
});

// The disconnect page lists the placeholders: the empty files a client wrote
// where it couldn't download a file. Disconnecting removes them, since only
// that client can fetch their bytes. The listing reads the folder's whole
// index, so it runs on this page only, and a failure just leaves it out.
const PLACEHOLDERS_SHOWN = 20;

client_routes.get("/:client/disconnect", async (req, res, next) => {
  try {
    const found = [];
    for await (const file of storage.flagged(req.blog.id)) {
      if (!file.placeholder) continue;
      const flag = (file.flags || []).find(
        (flag) => fileFlags.CODES[flag.code]?.placeholder
      );
      const code = flag && fileFlags.CODES[flag.code];
      found.push({
        path: file.path,
        reason: code ? code.message : "couldn't be downloaded",
      });
    }
    if (found.length) {
      found.sort((a, b) => a.path.localeCompare(b.path));
      res.locals.placeholders = {
        count: found.length,
        one: found.length === 1,
        shown: found.slice(0, PLACEHOLDERS_SHOWN),
        more: Math.max(0, found.length - PLACEHOLDERS_SHOWN),
      };
    }
  } catch (err) {
    console.error("Could not list placeholders", req.blog.id, err.message);
  }
  next();
});

for (let client_name in clients) {
  const client = clients[client_name];

  if (!client.dashboard_routes) continue;

  client_routes.use("/" + client.name, client.dashboard_routes);
}

client_routes.use("/:client", (req, res) => {
  res.redirect(`${res.locals.dashboardBase}/sync`);
});

module.exports = client_routes;
