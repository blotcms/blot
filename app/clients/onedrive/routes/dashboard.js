const express = require("express");
const crypto = require("crypto");
const dashboard = express.Router();
const disconnect = require("clients/onedrive/disconnect");
const Database = require("clients/onedrive/database");
const oauth = require("clients/onedrive/util/oauth");
const Blog = require("models/blog");
const views = __dirname + "/../views/";

dashboard.use(function loadOneDriveAccount(req, res, next) {
  Database.get(req.blog.id, function (err, account) {
    if (err) return next(err);

    if (!account) return next();

    res.locals.account = req.account = account;
    res.locals.revoked = account.error_code === 401;

    next();
  });
});

// The settings page for a connected OneDrive account
dashboard.get("/", function (req, res) {
  if (!req.account) {
    return res.redirect(req.baseUrl + "/setup" + (req.query.setup ? "?setup=true" : ""));
  }

  res.render(views + "index");
});

// Explains what will happen when they connect, then links to /redirect
dashboard.get("/setup", function (req, res) {
  res.render(views + "authenticate");
});

// Sends the user to Microsoft to consent. The cookies let the public
// /clients/onedrive/authenticate route find this blog again and check
// `state` (see routes/site.js). They must be readable on the cross-site
// redirect back from Microsoft, hence sameSite Lax.
dashboard.get("/redirect", function (req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  const cookie = {
    domain: "",
    path: "/",
    secure: true,
    httpOnly: true,
    maxAge: 15 * 60 * 1000, // 15 minutes
    sameSite: "Lax",
  };

  res.cookie("onedriveBlog", req.blog.handle, cookie);
  res.cookie("onedriveState", state, cookie);
  res.redirect(oauth.authorizeUrl(state));
});

// Reached from the site route above once the user has consented:
// swap the code for tokens, identify the account and save it.
dashboard.get("/authenticate", async function (req, res, next) {
  try {
    if (!req.query.code) throw new Error("No authorization code from OneDrive");

    const tokens = await oauth.exchangeCode(req.query.code);
    const profile = await oauth.getProfile(tokens.access_token);

    await new Promise(function (resolve, reject) {
      Database.set(
        req.blog.id,
        {
          account_id: profile.account_id,
          email: profile.email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          error_code: 0,
        },
        function (err) {
          err ? reject(err) : resolve();
        }
      );
    });

    await new Promise(function (resolve, reject) {
      Blog.set(req.blog.id, { client: "onedrive" }, function (err) {
        err ? reject(err) : resolve();
      });
    });

    res.redirect(req.baseUrl);
  } catch (err) {
    next(err);
  }
});

dashboard.get("/disconnect", function (req, res) {
  res.render(views + "disconnect");
});

dashboard.post("/disconnect", function (req, res, next) {
  disconnect(req.blog.id, function (err) {
    if (err) return next(err);
    res.redirect(res.locals.base + "/client");
  });
});

module.exports = dashboard;
