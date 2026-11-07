const express = require("express");
const site = express.Router();
const sync = require("clients/dropbox/sync");
const Database = require("clients/dropbox/database");
const debug = require("debug")("blot:clients:dropbox:routes");
const config = require("config");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const clfdate = require("helper/clfdate");
const Blog = require("models/blog");
const followUpSync = require("clients/util/followUpSync");

// This is called by Dropbox when the user
// authorizes Blot's access to their folder
// as part of the OAUTH flow. We then redirect
// them to a dashboard route within the Dropbox client
// Customers are sent back to:
// blot.im/clients/dropbox/authenticate
// when they have authorized (or declined to authorize)
// Blot's access to their folder. This is a public-facing
// route without access to the customer's session by default.
// We need to work out which blog they were
// authenticating based on a value stored in their session
// before they were sent out to Dropbox. Unfortunately we
// can't pass a blog username in the URL, since it needs to
// be the same URL every time, e.g. this would not work:
// blot.im/clients/dropbox/authenticate?handle=david
site.get("/authenticate", cookieParser(), function (req, res, next) {
  const handle = req.cookies.blogToAuthenticate;
  if (!handle) {
    return next(new Error("No blog to authenticate"));
  }
  let redirect =
    "/sites/" +
    encodeURIComponent(handle) +
    "/client/dropbox/authenticate?code=" +
    encodeURIComponent(req.query.code || "");
  if (req.query.full_access) redirect += "&full_access=true";

  res.clearCookie("blogToAuthenticate");
  // redirect is a same-origin path with all user input percent-encoded, so
  // no untrusted value is interpolated into HTML or JS. res.redirect emits a
  // Location header plus a safe default body.
  res.redirect(redirect);
});

// We keep a dictionary of synced blogs for testing
// purposes. There isn't an easy way to determine
// after pushing whether or not Blot has completed the
// sync of the blog's folder. This is because I can't
// work out how to do something asynchronous after we've
// accepted a push but before we've sent the response.
var activeSyncs = {};

function started(blogID) {
  if (activeSyncs[blogID] === undefined) activeSyncs[blogID] = 0;
  activeSyncs[blogID]++;
}

function finished(blogID) {
  activeSyncs[blogID]--;
}

function finishedAllSyncs(blogID) {
  return activeSyncs[blogID] === 0;
}

// Used for testing purposes only to determine when a sync has finished
// Redlock means we can't reliably determine this just by calling sync()
// A follow-up still queued in Redis counts as a sync to come.
site.get("/webhook/syncs-finished/:blogID", async function (req, res, next) {
  try {
    const blogID = req.params.blogID;
    res.send(finishedAllSyncs(blogID) && !(await followUps.pending(blogID)));
  } catch (err) {
    next(err);
  }
});

// This is called by Dropbox to verify the webhook exists
site.get("/webhook", function (req, res, next) {
  if (!req.query || !req.query.challenge) return next();
  res.send(req.query.challenge);
});
// Syncs a blog, or leaves a follow-up for any process to run once a sync
// already running (here or in another container) has finished
const followUps = followUpSync("dropbox", async function (blogID) {
  const blog = await Blog.get({ id: blogID });
  if (!blog) return;

  await sync(blog);
});

// Syncs the blogs connected to each of the accounts. The accounts, and the
// blogs of each account, are synced in parallel.
async function syncAccounts(accounts) {
  await Promise.all(
    accounts.map(async function (account_id) {
      debug("Checking blogs for Dropbox account", account_id);

      let blogs;

      try {
        blogs = await Database.listBlogs(account_id);
      } catch (err) {
        console.error(
          clfdate(),
          "Dropbox: Webhook failed to list blogs for account",
          account_id,
          err
        );
        return;
      }

      debug("Syncing", blogs.length, "blogs");

      await Promise.all(
        blogs.map(async function (blog) {
          // Used for testing purposes only
          started(blog.id);

          try {
            await followUps.run(blog.id);
          } catch (err) {
            console.error(
              clfdate(),
              "Dropbox: Webhook sync error",
              blog.id,
              err
            );
          }

          debug("Finish sync for", blog.id);
          finished(blog.id);
        })
      );
    })
  );
}

site.post("/webhook", function (req, res) {
  var data = "";
  var accounts = [];
  var signature = req.headers["x-dropbox-signature"];
  var secret;

  if (req.query.full_access) {
    secret = config.dropbox.full.secret;
  } else {
    secret = config.dropbox.app.secret;
  }

  var verification = crypto.createHmac("SHA256", secret);

  req.setEncoding("utf8");

  req.on("data", function (chunk) {
    data += chunk;
    verification.update(chunk);
  });

  req.on("end", function () {
    if (signature !== verification.digest("hex")) {
      return res.sendStatus(403);
    }

    try {
      accounts = JSON.parse(data).list_folder.accounts;
    } catch (e) {
      console.log("invalid accounts");
      return res.sendStatus(504);
    }

    // Tell Dropbox we retrieved the list of accounts
    res.sendStatus(200);

    // Sync each of the accounts! Nothing waits for the syncs to finish,
    // Dropbox has been answered already.
    syncAccounts(accounts).catch(function (err) {
      console.error(clfdate(), "Dropbox: Webhook error", err);
    });
  });
});

module.exports = site;
