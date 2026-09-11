const clients = require("clients");
const _ = require("lodash");
const moment = require("moment");
const express = require("express");
const client_routes = express.Router();
const Path = require("path");
const Blog = require("models/blog");
const load = require("./load");
const Sync = require("sync");
const Fix = require("sync/fix");
const Rebuild = require("sync/rebuild");
const config = require("config");
const fetch = require("node-fetch");

const { promisify } = require("util");
const getStatuses = promisify(Blog.getStatuses);

// So the breadcrumbs look like: Settings > Client
client_routes.use(function (req, res, next) {
  res.locals.breadcrumbs.add("Folder", "client");
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

    res.render("dashboard/clients/switch", {
      title: "Switch to another client",
    });
  })

  .post(function (req, res, next) {
    const redirect = req.baseUrl + "/" + req.body.client;

    if (!req.body.client) {
      return next(new Error("Please select a client"));
    }

    if (req.body.client === req.blog.client) return res.redirect(redirect);

    clients[req.blog.client].disconnect(req.blog.id, function (err) {
      if (err) return next(err);
      Blog.set(req.blog.id, { client: req.body.client }, function (err) {
        if (err) return next(err);

        res.redirect(redirect);
      });
    });
  });

// Used to change tense of activity on dashboard
// and to help parse paths from status messages
const verbs = {
  Downloading: "downloaded",
  Syncing: "synced",
  Transferring: "transferred",
  Removing: "removed",
};

// Reset progress messages are prefixed with "(current/total) ", e.g.
// "(1/10) Downloading /post.md" - strip it before matching a verb so
// these still parse into a path, verb and folder URL below.
const PROGRESS_PREFIX = /^\(\d+\/\d+\)\s+/;

client_routes.route("/activity").get(load.clients, async function (req, res) {
  res.locals.breadcrumbs.add("Activity", "activity");

  let { statuses, next, previous } = await getStatuses(req.blog.id);

  statuses = _.chain(statuses)
    .groupBy("syncID")
    .map((value, key) => ({
      syncID: key,
      messages: value
        .map((item) => {
          const message = item.message.replace(PROGRESS_PREFIX, "");
          const matchedVerb = Object.keys(verbs).find((i) =>
            message.startsWith(i + " /")
          );

          if (matchedVerb) {
            const path = message.slice((matchedVerb + " ").length);
            item.path = Path.parse(path);
            item.verb = verbs[matchedVerb];
            item.url = Path.join(
              res.locals.base,
              "folder",
              encodeURIComponent(path.slice(1))
            );
          }

          item.fromNow = moment(item.datestamp).fromNow();

          return item;
        })
        .filter(({ message }) => message !== "Syncing" && message !== "Synced"),
    }))
    .filter((i) => i.messages && i.messages.length)
    .value();

  res.render("dashboard/clients/activity", {
    title: "Activity",
    statuses,
    next,
    previous,
  });
});

client_routes

  .route("/reset")

  .get(load.client, function (req, res) {
    res.locals.breadcrumbs.add("Reset", "reset");
    res.render("dashboard/clients/reset", {
      title: "Reset your folder",
    });
  });

client_routes.post("/reset/rebuild", function (req, res) {
  Sync(req.blog.id, function (err, folder, done) {
    if (err) {
      return res.message(
        res.locals.base + "/client/reset",
        new Error("Failed to rebuild folder since it is syncing")
      );
    }

    res.message(
      res.locals.base + "/client/reset",
      "Begin rebuild of your site"
    );

    folder.status("Rebuilding your site");

    const thumbnails = !!req.query.thumbnails;
    const imageCache = !!req.query.imageCache;

    Rebuild(
      req.blog.id,
      { thumbnails, imageCache, status: folder.status, log: folder.log },
      function (err) {
        if (err) console.log(err);
        folder.status("Checking your site for issues");
        Fix(req.blog, { status: folder.status, log: folder.log }, function (err) {
          if (err) console.log(err);
          folder.status("Finished site rebuild");
          done(null, function (err) {
            if (err) console.log("Error releasing sync: ", err);
          });
        });
      }
    );
  });
});

client_routes.post("/reset/resync", load.client, function (req, res, next) {
  if (!res.locals.client.resync)
    return next(new Error("Cannot resync using your current client"));

  Sync(req.blog.id, async function (err, folder, done) {
    if (err) {
      return res.message(
        res.locals.base + "/client/reset",
        new Error("Failed to resync folder since it is syncing")
      );
    }

    res.message(res.locals.base + "/client/reset", "Begin resync of your site");

    try {
      await res.locals.client.resync(
        req.blog.id,
        folder.status,
        promisify(folder.update)
      );
    } catch (err) {
      console.log("ERROR:", err);
    }

    folder.status("Checking your site for issues");
    Fix(req.blog, { status: folder.status, log: folder.log }, function (err) {
      if (err) console.log(err);
      folder.status("Finished site rebuild");
      done(null, function (err) {
        if (err) console.log("Error releasing sync: ", err);
      });
    });
  });
});

// Generic open folder route for all clients (development only)
if (config.environment === "development") {
  const DEFAULT_OPEN_FOLDER_ORIGIN =
    process.env.LOCAL_OPEN_FOLDER_ORIGIN ||
    (process.env.CONTAINER_NAME
      ? "http://host.docker.internal:3020"
      : "http://localhost:3020");

  client_routes.get("/open", async function (req, res, next) {
    try {
      const openUrl = new URL(`${DEFAULT_OPEN_FOLDER_ORIGIN}/open-folder`);
      openUrl.searchParams.set("blogID", req.blog.id);

      // Include client type if available
      if (req.query.local) { 
        openUrl.searchParams.set("client", 'local');
      } else if (req.blog.client) {
        openUrl.searchParams.set("client", req.blog.client);
      }

      const response = await fetch(openUrl.href);

      if (!response.ok) {
        throw new Error("Request failed");
      }

      res.redirect(res.locals.base + "/client" + (req.blog.client ? "/" + req.blog.client : ""));
    } catch (error) {
      next(new Error("Could not open folder on your computer"));
    }
  });
}

client_routes
  .route("/")

  .get(load.clients, function (req, res) {
    if (req.blog.client) {
      return res.redirect(req.baseUrl + "/" + req.blog.client);
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
    return res.redirect(res.locals.base + "/client");
  }

  if (req.blog.client && req.params.client !== req.blog.client) {
    return res.redirect(res.locals.base + "/client/" + req.blog.client);
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
    ]);

    if (!allowedUnpersistedPaths.has(relativePath)) {
      return res.redirect(res.locals.base + "/client");
    }
  }

  res.locals.base = req.baseUrl;
  res.locals.effectiveClient = req.params.client;

  load.client(req, res, next);
});

for (let client_name in clients) {
  const client = clients[client_name];

  if (!client.dashboard_routes) continue;

  client_routes.use("/" + client.name, client.dashboard_routes);
}

client_routes.use("/:client", (req, res) => {
  res.redirect(`/sites/${req.blog.handle}/client`);
});

module.exports = client_routes;
