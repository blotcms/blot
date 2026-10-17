const { driveactivity, auth: googleAuth } = require("@googleapis/driveactivity");
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
    scopes: ["https://www.googleapis.com/auth/drive.activity.readonly"],
});

  return driveactivity({
    version: "v2",
    auth,
  });
}