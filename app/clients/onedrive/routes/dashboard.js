const express = require("express");
const dashboard = express.Router();
const disconnect = require("clients/onedrive/disconnect");
const views = __dirname + "/../views/";

// Skeleton dashboard routes. The connect page explains that OneDrive
// sync is on its way; the Microsoft sign-in redirect, callback and
// folder setup are added once the OAuth flow is built (PLAN.md,
// "User flow (dashboard)").
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
