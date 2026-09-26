const config = require("config");

// The URL Microsoft sends the user back to after they consent. It must
// match the redirect URI registered on the Entra app exactly, and be the
// same for the authorize and token requests. In development we use the
// production relay host, as the Dropbox client does, so one registered
// URI can serve both (see config.webhooks).
module.exports = function redirectUri() {
  const host =
    config.environment === "development"
      ? config.webhooks.relay_host
      : config.host;

  return "https://" + host + "/clients/onedrive/authenticate";
};
