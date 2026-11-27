const { drive, auth: googleAuth } = require("@googleapis/drive");
const config = require("config");
const cachedAuth = require("./cachedAuth");
const retryConfig = require("./retryConfig");

const clients = new Map();

// With signal (a sync lock's folder.signal, sync/seize.js), the client is
// one of its own whose every request carries the signal, so a disconnect
// cuts off a listing or download in flight. It shares the cached auth, and
// so the token, and is never cached itself: the shared client is never
// changed.
module.exports = async (serviceAccountId, { signal } = {}) => {
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

  if (signal) return drive({ version: "v3", auth, retryConfig, signal });

  // One client per auth, so every sync shares its token (cachedAuth.js)
  if (!clients.has(auth))
    clients.set(auth, drive({ version: "v3", auth, retryConfig }));
  return clients.get(auth);
};
