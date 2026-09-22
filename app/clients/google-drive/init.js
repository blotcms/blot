const clfdate = require("helper/clfdate");
const prefix = () => `${clfdate()} Google Drive client:`;

// Service accounts are down. Restore watching/polling from git history.
module.exports = async () => {
  console.log(prefix(), "Paused; not watching or polling Google Drive");
};
