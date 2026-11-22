const clfdate = require("helper/clfdate");
const { SETUP_MIN_AGE_MS } = require("./store/leftovers");

// At startup, clears the scratch directories of setups killed by the deploy
// or crash that restarted the process. They can be gigabytes, and the daily
// upkeep only removes them after twelve hours. A setup in use touches its
// directory as it runs, so one untouched for an hour is a leftover. Never
// throws.
module.exports = async function init() {
  try {
    const maintenance = require("./served/maintenance");
    if (!maintenance.configured()) return;
    await maintenance.scratch({
      minAge: SETUP_MIN_AGE_MS,
      prefixes: ["setup-"],
    });
  } catch (err) {
    console.log(
      clfdate(),
      "Git client: could not clear setup leftovers:",
      err.message
    );
  }
};
