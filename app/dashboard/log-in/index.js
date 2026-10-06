var Express = require("express");

var blockCrawlers = require("./blockCrawlers");
var checkToken = require("./checkToken");
var checkReset = require("./checkReset");
var checkEmail = require("./checkEmail");
var checkPassword = require("./checkPassword");
var errorHandler = require("./errorHandler");
var { redisUnavailableHandler } = require("helper/redisUnavailable");
var redirect = require("./redirect");

var form = new Express.Router();

// Used to give context to the user when not logged in.
// E.g. please log in to access the Services page
var DASHBOARD_PAGE_DESCRIPTION = {
  "/questions/ask": "ask a question",
  "/settings/urls/redirects": "set up redirects on your dashboard",
  "/settings/404s": "view 404s on your dashboard",
  "/settings/permalinks": "set the link format on your dashboard",
  "/settings/links": "edit the links on your dashboard",
  "/sites/default/settings/redirects": "set up redirects on your dashboard",
  "/sites/default/settings/redirects/404s": "view 404s on your dashboard",
  "/sites/default/settings/links": "edit the links on your dashboard"
};

form.use(function (req, res, next) {
  // Send logged-in users to the dashboard unless we're using
  // a one-time log-in link
  if (req.session && req.session.uid && !req.query.token) {
    var then = req.query.then || (req.body && req.body.then) || "/sites";
    return res.redirect(then);
  }

  res.header("Cache-Control", "no-cache");
  res.locals.title = "Log in";
  res.locals.from = req.query.from;
  res.locals.then = req.query.then;
  res.locals.then_description = DASHBOARD_PAGE_DESCRIPTION[req.query.then];

  return next();
});

form
  .route("/reset")

  .all(function (req, res, next) {
    next();
  })

  .get(function (req, res) {
    res.locals.title = "Reset password";
    res.locals.email = req.query.email;
    res.render("dashboard/log-in/reset");
  })

  .post(checkEmail, checkReset, errorHandler)

  .post(redisUnavailableHandler)

  .post(function (err, req, res, next) {
    res.render("dashboard/log-in/reset");
  });

form
  .route("/")

  .get(blockCrawlers, redirect, checkToken, function (req, res) {
    // if we've been sent from the 'log out' page this will be true
    res.locals.out = req.query.out;
    res.render("dashboard/log-in");
  })

  .post(require("./rateLimit"), checkEmail, checkReset, checkPassword)

  .all(errorHandler)

  .all(redisUnavailableHandler)

  .all(function (err, req, res, next) {
    if (req.body && req.body.reset !== undefined)
      return res.redirect("/log-in/reset");
    res.render("dashboard/log-in");
  });

module.exports = form;
