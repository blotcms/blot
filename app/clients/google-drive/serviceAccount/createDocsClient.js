const { docs, auth: googleAuth } = require("@googleapis/docs");
const config = require("config");

module.exports = async (serviceAccountId) => {
  const credentials = config.google_drive.service_accounts.find(
    (credentials) => credentials.client_id === serviceAccountId
  );

  if (!credentials) {
    throw new Error(`No credentials found for service account ${serviceAccountId}`);
  }

  const auth = new googleAuth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/documents.readonly"],
  });

  return docs({ version: "v1", auth });
};
