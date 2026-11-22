const config = require("config");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const drain = require("helper/drain");
const prefix = () => `${clfdate()} Google Drive client:`;
const createDriveActivityClient = require("./serviceAccount/createDriveActivityClient");
const refreshServiceAccounts = require("./serviceAccount/refreshServiceAccounts");
const pollDriveActivity = require("./serviceAccount/pollDriveActivity");
const readChanges = require("./serviceAccount/readChanges");
const searchEdits = require("./serviceAccount/searchEdits");
const pollRecentFolders = require("./serviceAccount/pollRecentFolders");
const syncChanges = require("./serviceAccount/syncChanges");
const createDriveClient = require("./serviceAccount/createDriveClient");
const hotDocPoller = require("./serviceAccount/hotDocPoller");
const { restartSetupProcesses } = require("./routes/setup");
const scheduleValidation = require("./validate");
const { exclusive, schedule } = require("clients/util/scheduleExclusive");
const onceAtStartup = require("clients/util/onceAtStartup");

const TEN_MINUTES_IN_MS = 10 * 60 * 1000;

const getServiceAccounts = () => config.google_drive.service_accounts || [];

// Run from one process every ten minutes (see refreshServiceAccounts), and
// exclusive so a slow run isn't overlapped by the next.
const refresh = exclusive(
  "google-drive-service-accounts",
  refreshServiceAccounts
);

// One process at a time polls each service account's drive activity. The
// others wait on the lease and take over if the holder dies or stops.
const startActivityPolling = () => {
  const leases = getServiceAccounts().map(({ client_id: serviceAccountId }) =>
    lock.lease("google-drive-activity:" + serviceAccountId, async (signal) => {
      const driveactivity = await createDriveActivityClient(serviceAccountId);
      console.log(prefix(), "Set up polling for drive activity");
      await pollDriveActivity(serviceAccountId, driveactivity, signal);
    })
  );

  drain.onStart(() => Promise.all(leases.map((lease) => lease.stop())));

  return leases;
};

// One process at a time reads each service account's changes.list, runs
// its search for recent edits and lists its recently changed folders
// (serviceAccount/readChanges.js, searchEdits.js and pollRecentFolders.js),
// with takeover like the activity polling. Each syncs the
// blogs a change belongs to (serviceAccount/syncChanges.js), beside the
// changes.watch webhook, which is often seconds late (#2847).
const startChangesReading = () => {
  const leases = getServiceAccounts().flatMap(
    ({ client_id: serviceAccountId }) => [
      lock.lease("google-drive-changes:" + serviceAccountId, async (signal) => {
        const drive = await createDriveClient(serviceAccountId);
        console.log(prefix(), "Reading changes for", serviceAccountId);
        await readChanges(serviceAccountId, drive, signal, {
          onChanges: syncChanges,
        });
      }),
      lock.lease("google-drive-search:" + serviceAccountId, async (signal) => {
        const drive = await createDriveClient(serviceAccountId);
        console.log(prefix(), "Searching for edits for", serviceAccountId);
        await searchEdits(serviceAccountId, drive, signal, {
          onChanges: syncChanges,
        });
      }),
      lock.lease("google-drive-recent:" + serviceAccountId, async (signal) => {
        const drive = await createDriveClient(serviceAccountId);
        console.log(prefix(), "Listing recent folders for", serviceAccountId);
        await pollRecentFolders(serviceAccountId, drive, signal, {
          onChanged: syncChanges.syncDirectories,
        });
      }),
    ]
  );

  drain.onStart(() => Promise.all(leases.map((lease) => lease.stop())));

  return leases;
};

module.exports = async () => {
  if (getServiceAccounts().length === 0) {
    console.log(prefix(), "No service accounts found in the configuration.");
    return;
  }

  // Every ten minutes, in one process per run, to refresh the service account
  // data and renew the changes.watch channel
  schedule("google-drive-service-accounts", "*/10 * * * *", refresh);

  // Also at startup, so a fresh deploy doesn't wait up to ten minutes for its
  // channel. A deploy starts several processes at once; the first in each
  // ten minute window does it and the cron tick covers the rest.
  const bucket = Math.floor(Date.now() / TEN_MINUTES_IN_MS);
  lock
    .once("google-drive-init:" + bucket, TEN_MINUTES_IN_MS)
    .then((first) => first && refresh())
    .catch((err) => console.error(prefix(), "Startup refresh failed", err));

  // Re-watch for new folders for sites in the middle of the setup process,
  // and resume copies of site files that a restart interrupted.
  // Once per deploy across all processes.
  onceAtStartup("google-drive-restart-setup", () =>
    restartSetupProcesses()
  ).catch((err) =>
    console.error(prefix(), "Restarting setup processes failed", err)
  );

  hotDocPoller.start();
  scheduleValidation();
  startActivityPolling();
  startChangesReading();
};

module.exports.refresh = refresh;
