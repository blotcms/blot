const { docs, auth: googleAuth } = require("@googleapis/docs");
const config = require("config");
const cachedAuth = require("./cachedAuth");

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
    "https://www.googleapis.com/auth/documents.readonly",
  ]);

  return docs({ version: "v1", auth });
};
