// Arms a publication alarm (app/models/entry/scheduled.js) for every entry
// currently in a blog's "scheduled" list that lacks a correct one. The same
// reconcile runs hourly from the scheduler; run this at deploy to do it now.
// Idempotent; the only writes are the alarm sets.
//
// Usage: node scripts/entry/backfill-scheduled-alarms.js

const { reconcile } = require("models/entry/scheduled");

reconcile()
  .then((counts) => {
    console.log(
      `Blogs: ${counts.blogs}. Alarms set or corrected: ${counts.set}.`,
      counts.failed ? `Blogs failed: ${counts.failed}.` : ""
    );
    process.exit(counts.failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
