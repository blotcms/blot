// Sets the welcome email alarm for recent users who haven't been sent it and
// have no alarm. The scheduler runs this daily (welcome-email-reconcile); the
// script is for running it by hand. Safe to run again.
//
//   node scripts/user/backfill-welcome-alarms.js [days=7]

var User = require("models/user");

var days = parseFloat(process.argv[2]) || 7;

User.scheduleWelcomeEmail.reconcile({ days: days }).then(
  function (scheduled) {
    console.log("Scheduled", scheduled, "welcome email alarms");
    process.exit();
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);
