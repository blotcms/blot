var client;
var config = require("config");
var ensure = require("helper/ensure");

// Register new clients here
var clients = {
  git: require("./git"),
};

// If we have specified the required
// configuration to run the Dropbox app
if (
  config.dropbox.app.key &&
  config.dropbox.app.secret &&
  config.dropbox.full.key &&
  config.dropbox.full.secret
) {
  clients.dropbox = require("./dropbox");
}

// If we have the require creds to run
// the google drive app
if (config.google_drive.service_accounts.length) {
  clients['google-drive'] = require("./google-drive");
}

// If we have the required GitHub App credentials
if (
  config.github.app_id &&
  config.github.client_id &&
  config.github.client_secret &&
  config.github.private_key &&
  config.github.webhook_secret
) {
  clients.github = require("./github");
}

// If we have the required creds to run the iCloud integration
if (config.icloud.server_address) {
  clients['icloud'] = require("./icloud");
}

// Demo local client
if (config.environment === "development") {
  clients.local = require("./local");
}

// Verify that each client has the correct
// signature before exposing them to Blot.
for (var i in clients) {
  client = clients[i];

  // Required properties
  ensure(client.display_name, "string");
  ensure(client.description, "string");
  ensure(client.disconnect, "function");
  ensure(client.remove, "function");
  ensure(client.write, "function");

  if (client.site_routes) ensure(client.site_routes, "function");
  if (client.dashboard_routes) ensure(client.dashboard_routes, "function");
  if (client.getHealth) ensure(client.getHealth, "function");

  // This is used as an identifier in the DB
  // e.g. a blog's client will be set to this value
  client.name = i;
}

module.exports = clients;
