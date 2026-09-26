const express = require("express");
const dashboard = express.Router();
const disconnect = require("clients/dropbox/disconnect");
const setup = require("./setup");
const config = require("config");
const fetch = require("node-fetch");
const Database = require("clients/dropbox/database");
const { flagsFromAccount } = require("clients/dropbox/util/classifyError");
const join = require("path").join;
const moment = require("moment");
const { Dropbox } = require("dropbox");
const views = __dirname + "/../views/";
const client = require("models/client");
const Blog = require("models/blog");

dashboard.use(function loadDropboxAccount (req, res, next) {
  Database.get(req.blog.id, function (err, account) {
    if (err) return next(err);

    if (!account) return next();

    var last_sync = account.last_sync;
    var flags = flagsFromAccount(account);

    res.locals.account = req.account = account;

    if (last_sync) {
      res.locals.account.last_sync = moment.utc(last_sync).fromNow();
    }

    res.locals.account.folder_missing = flags.folder_missing;
    res.locals.account.revoked = flags.revoked;

    // A quota error while the initial transfer is still pending gets the
    // more specific "ran out of space while transferring" message below;
    // the same error_code once the transfer has completed is the generic
    // "storage full" message instead.
    res.locals.account.insufficient_space =
      flags.quota_exceeded && account.transfer_pending === true;
    res.locals.account.quota_exceeded =
      flags.quota_exceeded && account.transfer_pending !== true;

    // A stuck/interrupted initial transfer for any reason other than the
    // out-of-space case above, which gets its own more specific message.
    // While a setup is actually in progress, the "/" route below replaces
    // res.locals.account with req.session.dropbox before rendering, so this
    // flag (computed from the persisted account) never reaches the view for
    // a normal, still-running transfer - only a genuinely stuck one.
    res.locals.account.transfer_incomplete =
      account.transfer_pending === true && !flags.quota_exceeded;

    return next();
  });
});

// The settings page for a Dropbox account
dashboard.get("/", function (req, res) {
  // Ask to user to authenticate with Dropbox if they have not yet
  if (!req.account && !req.session.dropbox) {
    var query = "";
    if (req.query.setup) query = "?setup=true";
    return res.redirect(req.baseUrl + "/setup" + query);
  }

  if (req.session.dropbox) {
    res.locals.account = req.session.dropbox;
    res.locals.preparing = true;
    // Just in case we haven't acquired the sync lock
    // the first time this page is loaded, we set the
    // state of the blog to syncing...
    if (
      res.locals.blog.status === undefined ||
      res.locals.blog.status.message === "Synced"
    ) {
      res.locals.blog.status = {
        message: "Setting up your folder on Dropbox",
        state: "syncing"
      };
    }
  }

  var dropboxBreadcrumbs = [];
  var folder;

  if (res.locals.account.folder !== undefined) {
    if (res.locals.account.full_access) {
      folder = res.locals.account.folder;
    } else {
      folder = join("Apps", "Blot", res.locals.account.folder);
    }

    var folderSegments = folder.split("/").filter(Boolean);

    // https://www.dropbox.com/home/<path> opens a folder in the Dropbox web
    // app; the path mirrors the same folder path within the user's Dropbox
    // used above, so it's built from the same segments (percent-encoded,
    // since a blog's folder name is user-chosen).
    res.locals.dropboxUrl =
      "https://www.dropbox.com/home" +
      (folderSegments.length
        ? "/" + folderSegments.map(encodeURIComponent).join("/")
        : "");

    dropboxBreadcrumbs = folderSegments.map(function (name) {
      return { name: name };
    });

    // Full access to the root of Dropbox has no path segments after
    // stripping the "Dropbox" crumb - fall back to naming it so the
    // folder line still has something to show next to the icon.
    if (!dropboxBreadcrumbs.length) {
      dropboxBreadcrumbs = [{ name: "Dropbox" }];
    }

    dropboxBreadcrumbs[dropboxBreadcrumbs.length - 1].last = true;
  }

  res.locals.dropboxBreadcrumbs = dropboxBreadcrumbs;

  res.render(views + "index");
});

// Explains to the user what will happen when they authenticate
// then provides them with a link to the dropbox redirect
dashboard.get("/setup", function (req, res) {
  res.render(views + "authenticate");
});

// Allows the user to choose a new Dropbox account to connect
// then provides them with a link to the dropbox redirect
dashboard.get("/edit", function (req, res) {
  res.render(views + "edit");
});

// Redirects the user to the OAuth page on Dropbox.com
dashboard.get("/redirect", function (req, res) {
  var redirectUri, key, secret;

  var redirectHost =
    config.environment === "development"
      ? config.webhooks.relay_host
      : config.host;

  redirectUri =
    req.protocol + "://" + redirectHost + "/clients/dropbox/authenticate";

  // It's important that sameSite is set to false so the
  // cookie is exposed to us when OAUTH redirect occurs
  res.cookie("blogToAuthenticate", req.blog.handle, {
    domain: "",
    path: "/",
    secure: true,
    httpOnly: true,
    maxAge: 15 * 60 * 1000, // 15 minutes
    sameSite: "Lax"
  });

  if (req.query.full_access) {
    key = config.dropbox.full.key;
    secret = config.dropbox.full.secret;
    redirectUri += "?full_access=true";
  } else {
    key = config.dropbox.app.key;
    secret = config.dropbox.app.secret;
  }

  const dbconfig = {
    fetch,
    clientId: key,
    clientSecret: secret
  };

  const dbx = new Dropbox(dbconfig);

  // what are these mystery params
  dbx.auth
    .getAuthenticationUrl(
      redirectUri,
      null,
      "code",
      "offline",
      null,
      "none",
      false
    )
    .then(authUrl => {
      res.writeHead(302, { Location: authUrl });
      res.end();
    });

  // res.redirect(authentication_url);
});

// Explains to the user what happens when they change the
// permission they grant to Blot per access to their Dropbox
dashboard.get("/permission", function (req, res) {
  res.render(views + "permission");
});

// This route recieves the user back from
// Dropbox when they have accepted or denied
// the request to access their folder.
// N.B. This GET mutates and starts the initial upload, so nginx pins it to
// green rather than serving it on blue like other GETs (blot-site.conf).
dashboard.get("/authenticate", function (req, res, next) {
  // the user has reloaded this page
  // if (req.session.dropbox && req.session.dropbox.preparing === true) {
  //   console.log('here, redirecting cause of session');
  //   return res.redirect(req.baseUrl);
  // }

  const { code, full_access } = req.query;

  const redirectHost =
    config.environment === "development"
      ? config.webhooks.relay_host
      : config.host;

  let redirectUri =
    req.protocol + "://" + redirectHost + "/clients/dropbox/authenticate";

  if (full_access) {
    redirectUri += "?full_access=true";
  }

  const account = {
    code,
    redirectUri,
    full_access: full_access === "true",
    preparing: true,
    blog: req.blog
  };

  // this the first time the user has visited this page
  req.session.dropbox = account;

  Blog.set(req.blog.id, { client: "dropbox" }, function (err) {
    if (err) return next(err);

    setup(account, req.session, function (err) {
      console.log("err setting up", err);
    });

    res.redirect(req.baseUrl);
  });
});

// Will remove the Dropbox account from the client's database
// and revoke the token if needed.
dashboard.get("/disconnect", function (req, res) {
  res.render(views + "disconnect");
});

dashboard.post("/disconnect", function (req, res, next) {
  if (!req.blog.client) {
    return res.redirect(res.locals.dashboardBase + "/client");
  }

  client
    .publish(
      "sync:status:" + req.blog.id,
      "Attempting to disconnect from Dropbox"
    )
    .catch((err) => console.error("failed to publish dropbox disconnect status", err));
  delete req.session.dropbox;
  disconnect(req.blog.id, next);
});

module.exports = dashboard;
