const Express = require("express");
const dashboard = require("dashboard");
const documentation = require("documentation");
const mustache = require("helper/express-mustache");
const config = require("config");

const VIEW_DIRECTORY = config.views_directory;

// Cache ID is used for the static assets
// eventually remove this when you merge
// the assets into a single file
const cacheID = Date.now();

const cdnURLHelper = require('documentation/tools/cdn-url-helper');

const site = Express();

site.locals.cdn = cdnURLHelper({cacheID, viewDirectory: VIEW_DIRECTORY});

// Hide the header added by Express
site.disable("x-powered-by");

// Trust exactly one proxy hop (the NGINX/OpenResty edge on 127.0.0.1).
//
// This is the app that actually handles /sites/log-in (mounted via vhost in
// server.js), so Express resolves req.ip using this app's trust setting. NGINX
// appends the real client address to X-Forwarded-For, so `true` would trust the
// whole chain and let a client spoof req.ip via the left-most XFF entry,
// bypassing the log-in rate limiter. A hop count of 1 pins req.ip to the
// address NGINX appended. Keep this in sync with server.js.
site.set("trust proxy", 1);

// Register the engine we will use to
// render the views.
site.set("view engine", "html");
site.set("views", VIEW_DIRECTORY);
site.engine("html", mustache);

// For when we want to cache templates
if (config.environment !== "development") {
  site.enable("view cache");
}

const { plan } = config.stripe;

site.locals.layout = "partials/layout";
site.locals.ip = config.ip;
site.locals.date = require("documentation/dates");
site.locals.price = "$" + plan.split("_").pop();
site.locals.interval = plan.startsWith("monthly") ? "month" : "year";
site.locals.cacheID = cacheID;

site.locals.cdnURL = config.cdn.origin;
site.locals.cdn = cdnURLHelper({cacheID, viewDirectory: VIEW_DIRECTORY});

site.get("/health", (req, res) => {
  res.send("OK");
});

// If the site is in maintenance mode, show the maintenance page
// rather than render the dashboard or any routes manipulate state
if (config.maintenance) {
  site.use(["/sites", "/clients", "/stripe-webhook", "/paypal-webhook"], (req, res) => {
    res.status(503);
    res.send("Down for maintenance");
  });
}

// The dashboard
// -------
site.use("/sites", dashboard);

// The client requests handler
site.use("/clients", require("clients/routes"));

// The stripe webhook handler
site.use("/stripe-webhook", require("dashboard/webhooks/stripe_webhook"));

site.use("/paypal-webhook", require("dashboard/webhooks/paypal_webhook"));

// The documentation
// ------------
// The least important application. It serves the documentation
site.use(documentation);

module.exports = site;
