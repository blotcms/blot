const database = require("../database");
const disconnect = require("../disconnect");
const parseBody = require("body-parser").urlencoded({ extended: false });

const express = require("express");
const dashboard = new express.Router();

const VIEWS = require("path").resolve(__dirname + "/../views") + "/";

dashboard.use(async function (req, res, next) {
  try {
    res.locals.account = await database.blog.get(req.blog.id);

    if (res.locals.account && res.locals.account.serviceAccountId) {
      res.locals.serviceAccount = await database.serviceAccount.get(
        res.locals.account.serviceAccountId
      );
    }

    next();
  } catch (err) {
    next(err);
  }
});

dashboard.get("/", function (req, res) {
  if (!res.locals.account) {
    return res.redirect(req.baseUrl + "/connect");
  }

  res.render(VIEWS + "index");
});

dashboard
  .route("/disconnect")
  .get(function (req, res) {
    res.render(VIEWS + "disconnect");
  })
  .post(function (req, res, next) {
    disconnect(req.blog.id, next);
  });

dashboard.route("/connect").get(function (req, res) {
  res.render(VIEWS + "connect");
});

dashboard.route("/setup").get(async function (req, res, next) {
  try {
    if (res.locals.account && res.locals.account.email) {
      res.locals.suggestedEmail = res.locals.account.email;
    } else {
      let suggestedEmail = req.user.email;

      const otherBlogIDs = req.user.blogs.filter((id) => id !== req.blog.id);
      const otherDriveAccounts = await Promise.all(
        otherBlogIDs.map((id) => database.blog.get(id))
      );

      otherDriveAccounts.forEach((account) => {
        if (account && account.email) {
          suggestedEmail = account.email;
          return;
        }
      });

      res.locals.suggestedEmail = suggestedEmail;
    }

    res.render(VIEWS + "setup");
  } catch (err) {
    next(err);
  }
});

dashboard
  .route("/set-up-folder")
  .post(parseBody, async function (req, res, next) {
    try {
      const existingAccount = await database.blog.get(req.blog.id);

      if (req.body.cancel) {
        if (!req.blog.client) {
          return res.redirect(res.locals.dashboardBase + "/client");
        }

        if (existingAccount && existingAccount.folderId && !existingAccount.error) {
          return res.redirect(req.baseUrl);
        }

        return disconnect(req.blog.id, next);
      }

      // Service accounts are down. Restore setup from git history.
      return res.message(
        req.baseUrl,
        "Google Drive setup is paused"
      );
    } catch (err) {
      next(err);
    }
  });

module.exports = dashboard;
