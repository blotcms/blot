const Bottleneck = require("bottleneck");
const database = require("clients/google-drive/database");
const clfdate = require("helper/clfdate");
const followUps = require("clients/google-drive/sync/followUps");
const hotDocPoller = require("./hotDocPoller");

const GOOGLE_DOC = "application/vnd.google-apps.document";

// The Google Docs an activity edited: Drive Activity names them within
// seconds of an edit, while the Doc's modifiedTime (all a sync walk sees)
// lags by about 2 minutes
const editedDocs = (activity) =>
  activity.primaryActionDetail?.edit
    ? (activity.targets || [])
        .map((target) => target.driveItem)
        .filter((item) => item?.mimeType === GOOGLE_DOC && item.name)
        .map((item) => item.name.replace(/^items\//, ""))
    : [];

const prefix = () => `${clfdate()} Google Drive:`;

const POLL_EVERY_MS = 5000;
// Activities read per poll of a blog: more than a blog sees in 5s. Beyond
// that the full sync started on any new activity still catches the rest,
// once Drive's modifiedTime moves.
const ACTIVITY_PAGE = 50;

// Resolves after ms, or as soon as the signal aborts
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();

    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });

// Runs a blog's sync through the follow-up queue, logging rather than
// rejecting if it fails: the follow-up it was armed with retries it
async function runSync(blogID, armed, prefix) {
  try {
    await followUps.run(blogID, armed, { trigger: "activity" });
  } catch (err) {
    console.error(prefix(), "sync failed", err.message);
  }
}

// Polls every blog on the service account for Drive activity until the signal
// aborts (see init.js, which runs this under a lease so only one process polls
// each service account). Resolves once the loop has stopped.
module.exports = async (
  serviceAccountId,
  driveactivity,
  signal = new AbortController().signal
) => {
  if (!serviceAccountId || !driveactivity) {
    throw new Error("Missing required arguments for pollDriveActivity");
  }

  // This allows up to 48 calls per minute total for a given service account
  // which represents half of the actual quota limit for the Drive API.
  const limiter = new Bottleneck({
    minTime: 1250,
    maxConcurrent: 1,
  });

  const checkDriveActivity = limiter.wrap(
    async (blogID, folderId, latestDriveActivityTimestamp) => {
      const prefix = () =>
        `${clfdate()} Google Drive client: serviceAccountId=${serviceAccountId} pollDriveActivity: ${blogID}`;

      if (!blogID || !folderId) {
        console.log(prefix(), "missing blogID or folderId");
        return;
      }

      // console.log(prefix(), "fetching");

      // Every activity since the one stored (newest first), so two Docs
      // edited between polls are both watched; the first time, just the
      // latest, to store its timestamp
      const res = await driveactivity.activity.query({
        requestBody: {
          pageSize: latestDriveActivityTimestamp ? ACTIVITY_PAGE : 1,
          ancestorName: `items/${folderId}`,
          ...(latestDriveActivityTimestamp && {
            filter: `time > "${latestDriveActivityTimestamp}"`,
          }),
        },
      });

      const activities = res.data?.activities || [];
      const activity = activities.find((a) => a.timestamp);
      const timestamp = activity?.timestamp;

      if (!activity) {
        // console.log(prefix(), "Warning: no activity found");
        return;
      }

      if (timestamp !== latestDriveActivityTimestamp) {
        // The shared follow-up queue starts the sync, as it does for the
        // change feed and the search (syncChanges.js): a blog already
        // syncing gets one more sync once that one has finished, rather than
        // a "Failed to acquire folder lock" here. The follow-up is armed in
        // Redis before the timestamp is stored, so the activity can't be
        // lost if this process dies first, and a sync that fails is retried
        // by the follow-up, not by noticing the same activity again.
        let armed;
        if (latestDriveActivityTimestamp) {
          armed = await followUps.arm(blogID);
          console.log(prefix(), "starting sync");
        }
        console.log(prefix(), "storing timestamp", timestamp);
        await database.blog.update(blogID, {
          latestDriveActivityTimestamp: timestamp,
        });
        // Not awaited: a long sync of one blog mustn't hold up polling the
        // others on the service account
        if (latestDriveActivityTimestamp) runSync(blogID, armed, prefix);

        // An edited Doc is polled from now, and its first poll publishes the
        // edit: the sync above can't, until Drive's modifiedTime moves
        const edited = new Set(activities.flatMap(editedDocs));
        if (latestDriveActivityTimestamp)
          for (const fileId of edited)
            await hotDocPoller
              .enqueue({
                blogID,
                serviceAccountId,
                fileId,
                folderId,
                unseen: true,
              })
              .catch((err) =>
                console.error(prefix(), "hot doc enqueue failed", err.message)
              );
      } else {
        // console.log(prefix(), "no new activity");
      }
    }
  );

  while (!signal.aborted) {
    try {
      // 1) Iterate over each blog. For each blog, queue the check in Bottleneck.
      await database.blog.iterateByServiceAccountId(
        serviceAccountId,
        async (blogID, account) => {
          const { folderId, latestDriveActivityTimestamp } = account;
          if (!folderId || signal.aborted) return;

          try {
            await checkDriveActivity(
              blogID,
              folderId,
              latestDriveActivityTimestamp
            );
          } catch (err) {
            console.error(prefix(), "checkDriveActivity error:", err);
          }
        }
      );
    } catch (err) {
      console.error("Error during iterateByServiceAccountId:", err);
    }
    // wait 5 seconds and avoid blocking the event loop
    await sleep(POLL_EVERY_MS, signal);
  }
};

module.exports.editedDocs = editedDocs;
