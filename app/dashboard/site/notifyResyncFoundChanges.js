const email = require("helper/email");
const countChanges = require("clients/util/countChanges");

// Resync is triggered manually from the dashboard (Reset your folder), so
// any change it finds is evidence this blog's regular webhook/cron sync
// missed it - email the admin so it can be investigated. Each client's
// summary flags changes made after its walk started (see
// clients/util/countChanges.js) so live edits that land during the resync
// itself aren't mistaken for a missed sync. Fire-and-forget: a failure here
// must never affect the resync flow the user is watching, which is why this
// takes no callback of its own.
module.exports = function notifyAdminIfResyncFoundChanges(
  blog,
  client,
  summary
) {
  try {
    if (!summary) return;

    const changeCount = countChanges(summary);

    if (!(changeCount > 0)) return;

    const breakdown = summary || {};

    // These reset POSTs always run on green (see the note above
    // reset/rebuild in client.js), regardless of which client just
    // resynced.
    email.RESYNC_FOUND_CHANGES(
      null,
      {
        id: blog.id,
        handle: blog.handle,
        truncatedId: blog.id.slice(0, 12),
        client: client.display_name,
        changeCount,
        changeCountPlural: changeCount !== 1,
        downloaded: breakdown.downloaded || 0,
        removed: breakdown.removed || 0,
        createdDirs: breakdown.createdDirs || 0,
        modifiedDuringWalk: breakdown.modifiedDuringWalk || 0,
      },
      function (err) {
        if (err) {
          console.log("Error sending resync found changes email:", err);
        }
      }
    );
  } catch (err) {
    console.log("Error preparing resync found changes email:", err);
  }
};
