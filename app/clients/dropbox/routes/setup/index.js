const sync = require("sync");
const cancelled = require("../../util/cancelled");

const database = require("clients/dropbox/database");

const getAccount = require("./getAccount");
const createFolder = require("./createFolder");
const revokePreviousToken = require("./revokePreviousToken");
const resetFromBlot = require("../../sync/reset-from-blot");
const resetToBlot = require("../../sync/reset-to-blot");

// Resolves once the setup is finished and the sync has released the folder
// lock, or rejects with why it failed. A disconnect aborts the setup, through
// the lock's signal (folder.signal, sync/seize.js): the sync finishes straight
// away, with "Dropbox setup aborted", even while a step is still running -
// except the transfer itself, which writes to the folder, so setup waits for
// it to stop before releasing the lock. The signal also cuts off the
// transfer's requests to Dropbox.
function setup(account, session) {
  return sync(account.blog.id, function (folder) {
    return new Promise(function (resolve, reject) {
      const { signal } = folder;
      let cleaned = false;
      let finished = false;
      let transferring = false;

      // run() finishes once the transfer has stopped
      const onAbort = () => {
        if (!transferring) handleAbort();
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        signal.removeEventListener("abort", onAbort);
        console.log("Cleaning up Dropbox setup");
        try {
          delete session.dropbox;
          session.save();
        } catch (e) {
          console.log("Error cleaning up:", e);
        }
      };

      const handleAbort = () => {
        if (!signal.aborted) return false;
        finish(new Error("Dropbox setup aborted"));
        return true;
      };

      // Ends the sync, once
      const finish = async (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (err) return reject(err);
        resolve();
      };

      const run = async () => {
        try {
          folder.status("Loading Dropbox account");
          account = await getAccount(account);
          if (handleAbort()) return;
          session.save();

          folder.status("Creating folder in Dropbox");
          account = await createFolder(account, signal);
          if (handleAbort()) return;
          session.save();

          const previous = await database.get(account.blog.id);

          // The lock is released on abort, so a disconnect may drop the
          // account at any moment from here: don't write it back
          if (handleAbort()) return;

          await database.set(account.blog.id, {
            account_id: account.account_id,
            email: account.email,
            access_token: account.access_token,
            refresh_token: account.refresh_token,
            full_access: account.full_access,
            folder: account.folder,
            folder_id: account.folder_id,
            reused_folder: !!account.reused_folder,
            error_code: 0,
            last_sync: Date.now(),
            cursor: "",
            // Set before the initial transfer starts, and only cleared once
            // resetFromBlot finishes uploading every file. Until then, Dropbox
            // cannot be trusted as this blog's source of truth - see
            // transfer_pending's comment in database.js and transferIncomplete()
            // in util/constants.js.
            transfer_pending: true,
          });

          // Switching permission (app folder <-> full Dropbox) or re-authorizing
          // leaves the previous token valid at Dropbox: revoke it, best-effort.
          await revokePreviousToken(previous, {
            blogID: account.blog.id,
            access_token: account.access_token,
            refresh_token: account.refresh_token,
          });

          folder.status("Syncing your folder to Dropbox");
          if (handleAbort()) return;

          transferring = true;

          // upload folder contents to dropbox. The folder this blog used
          // before it disconnected (createFolder.js) may hold the person's
          // own changes, so only upload what it lacks, then bring its
          // changes into Blot.
          await resetFromBlot(
            account.blog.id,
            folder.status,
            signal,
            folder.update,
            { keepDropbox: !!account.reused_folder }
          );

          if (handleAbort()) return;

          if (account.reused_folder) {
            // The transfer is done, so a failure here doesn't fail setup:
            // the hourly validation runs the same walk again
            try {
              await resetToBlot(
                account.blog.id,
                folder.status,
                folder.update,
                signal
              );
            } catch (err) {
              if (cancelled(err, signal)) throw err;
              console.log("Error syncing reused Dropbox folder:", err);
            }
            if (handleAbort()) return;
          }
        } catch (err) {
          if (cancelled(err, signal)) {
            return finish(new Error("Dropbox setup aborted"));
          }

          folder.status("Error: " + err.message);
          return finish(err);
        }

        finish(null);
      };

      run();
    });
  });
}

module.exports = setup;
