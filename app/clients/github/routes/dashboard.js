const express = require("express");
const dashboard = express.Router();
const disconnect = require("clients/github/disconnect");
const views = __dirname + "/../views/";

// Skeleton dashboard routes. The connect page explains that GitHub sync
// is on its way; the install/OAuth redirect, repo picker, and transfer
// flow are added once the GitHub App credentials exist and the Redis
// schema is in place (PLAN.md, "User flow (dashboard)").
dashboard.get("/", function (req, res) {
  res.render(views + "connect");
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
