const { drive, auth: googleAuth } = require("@googleapis/drive");
const config = require("config");
const cachedAuth = require("./cachedAuth");
const retryConfig = require("./retryConfig");

const clients = new Map();

module.exports = async (serviceAccountId) => {
  const credentials = config.google_drive.service_accounts.find(
    (credentials) => credentials.client_id === serviceAccountId
  );

  if (!credentials) {
    throw new Error(
      `No credentials found for service account ${serviceAccountId}`
    );
  }

  const auth = cachedAuth(googleAuth.GoogleAuth, credentials, [
    "https://www.googleapis.com/auth/drive",
  ]);

  // One client per auth, so every sync shares its token (cachedAuth.js)
  if (!clients.has(auth))
    clients.set(auth, drive({ version: "v3", auth, retryConfig }));
  return clients.get(auth);
};
