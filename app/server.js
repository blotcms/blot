var config = require("config");
var Express = require("express");
var vhost = require("vhost");
var blog = require("blog");
var site = require("site");
var trace = require("helper/trace");
var clfdate = require("helper/clfdate");

// Welcome to Blot. This is the Express application which listens on port 8080.
// NGINX listens on port 80 in front of Express app and proxies requests to
// port 8080. NGINX handles SSL termination, cached response delivery and
// compression. See ../config/nginx for more. Blot does the rest.
var server = Express();

// Removes a header otherwise added by Express. No wasted bytes
server.disable("x-powered-by");

console.log(
  clfdate(),
  "Starting server on port",
  config.port,
  "host",
  config.host
);

// Trust exactly one proxy hop (the NGINX/OpenResty edge on 127.0.0.1).
//
// NGINX appends the real client address to X-Forwarded-For via
// $proxy_add_x_forwarded_for, so with `true` Express would trust the whole
// chain and resolve req.ip to the left-most, client-supplied XFF entry. That
// let a client rotate X-Forwarded-For to get a fresh express-rate-limit bucket
// per request and bypass the log-in rate limiter. With a hop count of 1,
// req.ip is the address NGINX appended, which a client cannot spoof.
server.set("trust proxy", 1);

// Check if the database is healthy
server.get("/redis-health", async function (req, res) {
  const createRedisClient = require("models/redis");
  const client = createRedisClient();

  // do not cache response
  res.set("Cache-Control", "no-store");

  try {
    await client.connect();
    await client.ping();
    res.send("OK");
  } catch (err) {
    res.status(400).send("Failed to ping redis");
  } finally {
    if (client.isOpen) {
      await client.quit();
    }
  }
});

// Prevent <iframes> embedding pages served by Blot while allowing
// exceptions for the configured host. Adds both X-Frame-Options and an
// equivalent Content-Security-Policy directive.
server.use(function (req, res, next) {
  if (!config.host) return next();

  var allowFromHeader = config.host;
  var allowFromOrigin = config.protocol + config.host;
  var frameAncestorsSources = ["'self'", allowFromOrigin];
  var frameAncestors = "frame-ancestors " + frameAncestorsSources.join(" ");

  res.set("X-Frame-Options", "ALLOW-FROM " + allowFromHeader);

  var existingCSP = res.get("Content-Security-Policy");

  if (existingCSP && /frame-ancestors/i.test(existingCSP)) {
    return next();
  }

  if (existingCSP) {
    var sanitized = existingCSP.trim().replace(/;$/, "");
    res.set("Content-Security-Policy", sanitized + "; " + frameAncestors);
  } else {
    res.set("Content-Security-Policy", frameAncestors);
  }

  next();
});

// Log response time in development mode
server.use(trace.init);

server.use(require('./request-logger'));

// Blot is composed of two sub applications.

// The Site
// -------------
// Serve the dashboard and public site (the documentation)
// Webhooks from Dropbox and Stripe, git pushes are
// served by these two applications. The dashboard can
// only ever be served for request to the host
server.use(vhost(config.host, site));

// The Webhook forwarder
// -------------
// Forwards webhooks to development environment
if (config.webhooks.server_host && config.master) {
  console.log(clfdate(), "Webhooks relay on", config.webhooks.server_host);
  server.use(vhost(config.webhooks.server_host, require("./clients/webhooks")));
}

console.log(clfdate(), "Setting up CDN on", "cdn." + config.host);
// CDN server
server.use(vhost("cdn." + config.host, require("./cdn")));

// The Blogs
// ---------
// Serves the customers's blogs. It should come first because it's the
// most important. We don't know the hosts for all the blogs in
// advance so all requests hit this middleware.
server.use(blog);

// Monit, which we use to monitor the server's health, requests
// localhost/health to see if it should attempt to restart Blot.
// If you remove this, change monit.rc too.
server.get("/health", function (req, res) {
  // do not cache response
  res.set("Cache-Control", "no-store");
  res.send("OK");
});

module.exports = server;
