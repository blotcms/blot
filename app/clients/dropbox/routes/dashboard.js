const express = require("express");
const dashboard = express.Router();
const disconnect = require("clients/dropbox/disconnect");
const setup = require("./setup");
const config = require("config");
const fetch = require("node-fetch");
const Database = require("clients/dropbox/database");
const health = require("clients/health");
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

    res.locals.account = req.account = account;

    if (last_sync) {
      res.locals.account.last_sync = moment.utc(last_sync).fromNow();
    }

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

    // getBlogHealth (dashboard/util/load-blog.js) already read this blog's
    // health before this route ran, straight from the persisted account
    // row - which, right after a fresh connect/reconnect, can still carry
    // the old durable error (e.g. REAUTH_REQUIRED) for the first few
    // seconds, until setup() (routes/setup/index.js) gets far enough to
    // clear error_code. We know better here: a session-tracked setup is
    // actively running, so show it as syncing instead of a stale error.
    delete res.locals.blog.healthIssue;
    res.locals.blog.health = health.syncing();
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

  // REAUTH_REQUIRED and SOURCE_MISSING are both resolved by sending the
  // user through Dropbox's OAuth flow again (setup() recreates the folder
  // afterwards if it's missing, for either access mode - see createFolder.js).
  // Point the health action straight at /redirect instead of the generic
  // /setup interstitial, so clicking it doesn't require clicking through
  // an explanation of something that's already happened before. Preserve
  // the account's existing access mode - full_access selects a different
  // Dropbox OAuth app (see redirectToDropbox below), so getting this wrong
  // would silently switch the user's permission level.
  if (res.locals.blog.healthIssue) {
    var issueCode = res.locals.blog.healthIssue.code;
    if (
      issueCode === health.CODES.REAUTH_REQUIRED ||
      issueCode === health.CODES.SOURCE_MISSING
    ) {
      res.locals.blog.healthIssue.actionUrl =
        res.locals.base +
        "/redirect" +
        (res.locals.account && res.locals.account.full_access
          ? "?full_access=true"
          : "");
    }
  }

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
  Database.get(req.blog.id, function (err, account) {
    // Remember whatever durable error is on the account right now, before
    // we optimistically clear it below. If the user cancels on Dropbox's
    // page (or the token exchange otherwise fails) /authenticate restores
    // this instead of leaving the blog looking healthy with a half-done
    // reconnect. Only a successful new token should actually clear it for
    // real - see the comment on /authenticate.
    req.session.dropboxPriorError =
      !err && account
        ? {
            error_code: account.error_code,
            error_source: account.error_source,
            error_since: account.error_since,
          }
        : null;

    req.session.save(function () {
      // Clear the durable error now, before the user ever leaves for
      // Dropbox, instead of waiting for setup() to get through
      // getAccount()/createFolder() (real network round trips) after they
      // come back. That gap is exactly what showed the old REAUTH_REQUIRED
      // error for a few seconds after a successful reconnect - clearing it
      // here removes the race instead of papering over it downstream.
      // error_source/error_since clear too - see database.js. dropboxPriorError
      // above is how we undo this if the round trip doesn't end up succeeding.
      Database.set(req.blog.id, { error_code: 0 }, function () {
        redirectToDropbox(req, res);
      });
    });
  });
});

function redirectToDropbox(req, res) {
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
}

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

  const { code, full_access, error } = req.query;

  // /redirect stashed whatever durable error was on the account before it
  // optimistically cleared error_code to 0 (see the comment there). Unless
  // the token exchange below actually succeeds, we put it back - otherwise
  // a cancelled or failed reconnect would leave the blog reporting healthy.
  const priorError = req.session.dropboxPriorError;
  delete req.session.dropboxPriorError;

  const restorePriorError = function (cb) {
    if (!priorError) return cb();

    // Only restore onto an account that actually exists - a first-time
    // connect that gets cancelled/fails should not create one.
    Database.get(req.blog.id, function (err, account) {
      if (err || !account) return cb();
      Database.set(
        req.blog.id,
        {
          error_code: priorError.error_code,
          error_source: priorError.error_source,
          error_since: priorError.error_since,
        },
        cb
      );
    });
  };

  // The user pressed "Cancel" on Dropbox's authorization page (error is
  // usually access_denied), or Dropbox otherwise sent us back without a
  // code. Either way there's no token to exchange, so don't call setup()
  // at all - that would just fail deep inside getAccount() with nothing
  // shown to the user.
  if (error || !code) {
    console.log(
      "Dropbox OAuth callback did not return a code",
      req.blog.id,
      error
    );

    delete req.session.dropbox;

    return req.session.save(function () {
      restorePriorError(function () {
        res.locals.error =
          error === "access_denied"
            ? "You cancelled Dropbox authorization, so Blot can't access your folder. Try again to connect."
            : "Something went wrong connecting to Dropbox. Try again to connect.";

        res.render(views + "authenticate");
      });
    });
  }

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
      if (err) {
        console.log("err setting up", err);
        // The code Dropbox gave us didn't actually lead to a working
        // account (expired/reused code, a Dropbox API error, etc). Put
        // back whatever durable error was there before /redirect cleared
        // it, for the same reason a cancelled authorization does above.
        return restorePriorError(function () {});
      }
    });

    // req.session.dropbox above must actually reach the session store
    // before the browser's next request (the redirect target below) can
    // see it - otherwise that request's own session read can race the
    // save from this one and come back without it, showing the stale
    // pre-reconnect error for a render or two until a later request
    // catches up. res.redirect() doesn't wait for that on its own.
    req.session.save(function () {
      res.redirect(req.baseUrl);
    });
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
