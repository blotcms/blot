const config = require("config");
const clfdate = require("helper/clfdate");
const prefix = () => `${clfdate()} Google Drive client:`;
const createDriveClient = require("./serviceAccount/createDriveClient");
const createDriveActivityClient = require("./serviceAccount/createDriveActivityClient");
const fetchStorageInfo = require("./serviceAccount/fetchStorageInfo");
const watchChanges = require("./serviceAccount/watchChanges");
const pollDriveActivity = require("./serviceAccount/pollDriveActivity");
const hotDocPoller = require("./serviceAccount/hotDocPoller");
const { restartSetupProcesses } = require("./routes/setup");

const main = async (initial = false) => {
  const serviceAccounts = config.google_drive.service_accounts;

  if (!serviceAccounts || serviceAccounts.length === 0) {
    console.log(prefix(), "No service accounts found in the configuration.");
    return;
  }

  // Re-watch for new folders for sites in the middle of the setup process
  if (initial) {
    restartSetupProcesses();
  }

  if (initial) {
    hotDocPoller.start();
  }

  for (const { client_id: serviceAccountId } of serviceAccounts) {
    try {
      const drive = await createDriveClient(serviceAccountId);
      const driveactivity = await createDriveActivityClient(serviceAccountId);

      console.log(prefix(), "Fetching storage usage of service account");
      await fetchStorageInfo(serviceAccountId, drive);

      await watchChanges(serviceAccountId, drive);

      // We only want to set up polling once, when the service account is first initialized
      if (initial) {
        console.log(prefix(), "Set up polling for drive activity");
        pollDriveActivity(serviceAccountId, driveactivity);
      }

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

module.exports = async () => {
  main(true);
  // we do this repeatedly every 10 minutes
  // to refresh the service account data
  // and renew the changes.watch channel
  setInterval(main, 1000 * 60 * 10);
};
