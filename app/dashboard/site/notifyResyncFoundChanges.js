const email = require("helper/email");
const syncReport = require("clients/util/syncReport");

// Resync is triggered manually from the dashboard (Reset your folder), so
// any change it finds is evidence this blog's regular webhook/cron sync
// missed it - email the admin so it can be investigated. Each client's
// summary flags changes made after its walk started (see
// clients/util/countChanges.js) so live edits that land during the resync
// itself aren't mistaken for a missed sync. Anything Fix() repaired right
// after the resync (fixReport, Fix()'s { [check]: items[] }) is included in
// the same email, and is enough to send it on its own: Fix() doesn't email,
// and this is the only place a dashboard-triggered repair gets reported.
// Fire-and-forget: a failure here must never affect the resync flow the user
// is watching, which is why this takes no callback of its own.
module.exports = function notifyAdminIfResyncFoundChanges(
  blog,
  client,
  summary,
  fixReport
) {
  try {
    const changes = syncReport.formatChanges(summary);
    const checks = syncReport.formatFix(fixReport);

    if (!changes.hasChanges && !checks.length) return;

    // These reset POSTs always run on green (see the note above
    // reset/rebuild in client.js), regardless of which client just
    // resynced.
    email.RESYNC_FOUND_CHANGES(
      null,
      Object.assign(
        {
          id: blog.id,
          handle: blog.handle,
          truncatedId: blog.id.slice(0, 12),
          client: client.display_name,
          hasRepairs: checks.length > 0,
          checks,
        },
        changes
      ),
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
