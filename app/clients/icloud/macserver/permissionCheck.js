import { blogIDs, rootOf } from "./blogFolder.js";
import sharePermission from "./util/sharePermission.js";
import status from "./httpClient/status.js";
import clfdate from "./util/clfdate.js";

// An owner can switch a folder's sharing to "View only" after setup (which
// turns a View only share down: routes/setup.js). Blot still reads the
// folder, but nothing it writes there reaches iCloud. So every few hours this
// reads each folder's permission and tells Blot when it changes, which shows
// it on the dashboard (VIEW_ONLY in clients/health.js) until it is fixed.
// Since the last report, from this process: a restart reports them all again.

const FIRST_CHECK_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const reported = new Map(); // blogID -> permission last told to Blot

export const checkPermissions = async () => {
  let readOnly = 0;
  let changed = 0;

  for (const blogID of blogIDs()) {
    let root;
    try {
      root = rootOf(blogID);
    } catch {
      continue; // the folder went while the check ran
    }

    // One read: a folder iCloud hasn't described yet is checked next time
    const permission = await sharePermission(root, { attempts: 1 });
    if (!permission) continue;
    if (permission === "readOnly") readOnly++;
    if (reported.get(blogID) === permission) continue;

    try {
      await status(blogID, { permission });
      reported.set(blogID, permission);
      changed++;
    } catch (error) {
      console.error(
        clfdate(),
        `Could not report the share permission of ${blogID}:`,
        error.message
      );
    }
  }

  console.log(
    clfdate(),
    `Share permissions checked: ${readOnly} View only, ${changed} reported`
  );
};

export default () => {
  const run = () =>
    checkPermissions().catch((error) =>
      console.error(clfdate(), "Share permission check failed:", error)
    );
  setTimeout(run, FIRST_CHECK_MS);
  setInterval(run, CHECK_EVERY_MS);
};
