const config = require("config");
const clfdate = require("helper/clfdate");
const createDriveClient = require("./createDriveClient");
const fetchStorageInfo = require("./fetchStorageInfo");
const watchChanges = require("./watchChanges");

const prefix = () => `${clfdate()} Google Drive client:`;

// Refreshes each service account's storage data and renews its changes.watch
// channel. watchChanges checks for a channel and then creates one, which two
// processes doing it at once could turn into duplicate channels and so
// duplicate webhooks, so init.js runs this from one process per run.
module.exports = async function refreshServiceAccounts() {
  const serviceAccounts = config.google_drive.service_accounts || [];

  for (const { client_id: serviceAccountId } of serviceAccounts) {
    try {
      const drive = await createDriveClient(serviceAccountId);

      console.log(prefix(), "Fetching storage usage of service account");
      await fetchStorageInfo(serviceAccountId, drive);

      await watchChanges(serviceAccountId, drive);

      // Todo: also sync all sites that are using this service account

      console.log(prefix(), "Service account is running successfully");
    } catch (e) {
      console.error(
        "Google Drive client: error with configuration of serviceAccount"
      );
      console.error(e);
    }
  }
};
