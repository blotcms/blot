const clfdate = require("helper/clfdate");
const database = require("../database");
const initialTransfer = require("./initialTransfer");
const { isSyncLockError } = require("../routes/lock");

// Runs again every initial transfer an account still marks as running. A
// deploy or crash can kill a transfer part way (the kill skips its catch, so
// transferringToiCloud stays true), and while that flag is set the hourly
// validation and every background sync leave the blog alone, so nothing
// else would ever finish it.
//
// A folder lock that is held usually means the transfer is still running in
// another process, so the blog is left for the next run. Resolves to how many
// blogs were left that way.
module.exports = async function resumeTransfers() {
  let busy = 0;

  await database.iterate(async (blogID, account) => {
    if (!account || account.transferringToiCloud !== true) return;

    try {
      console.log(clfdate(), "iCloud: Resuming initial transfer for", blogID);
      await initialTransfer(blogID);
    } catch (error) {
      if (isSyncLockError(error)) {
        busy += 1;
        console.log(
          clfdate(),
          "iCloud: Initial transfer for",
          blogID,
          "is locked, leaving it for the next run"
        );
        return;
      }
      console.error(
        clfdate(),
        "iCloud: Error resuming initial transfer for",
        blogID,
        error
      );
    }
  });

  return busy;
};
