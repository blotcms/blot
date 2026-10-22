const { drive, auth: googleAuth } = require("@googleapis/drive");
const config = require("config");
const retryConfig = require("./retryConfig");

module.exports = async (serviceAccountId) => {
  const credentials = config.google_drive.service_accounts.find(
    (credentials) => credentials.client_id === serviceAccountId
  );

  if (!credentials) {
    throw new Error(`No credentials found for service account ${serviceAccountId}`);
  }

  const auth = new googleAuth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return drive({ version: 'v3', auth, retryConfig });
}