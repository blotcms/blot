const sync = require("sync");
const redisSubscriber = require("helper/redisSubscriber");

const promisify = require("util").promisify;
const database = require("clients/dropbox/database");
const set = promisify(database.set);

const getAccount = require("./getAccount");
const createFolder = require("./createFolder");
const resetFromBlot = require("../../sync/reset-from-blot");

function setup(account, session, callback) {
  sync(account.blog.id, async function (err, folder, done) {
    if (err) return callback(err);

    const signal = { aborted: false };
    const abortChannel = "sync:status:" + account.blog.id;
    let abortHandled = false;
    let cleaned = false;
    let finished = false;

    const subscription = redisSubscriber({
      channel: abortChannel,
      onMessage: function (message) {
        if (message !== "Attempting to disconnect from Dropbox") return;
        signal.aborted = true;
        abortHandled = true;
        handleAbort();
      },
      onError: function (err) {
        console.log("Error:", err);
      },
    });

    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      console.log("Cleaning up Dropbox setup");
      try {
        delete session.dropbox;
        session.save();
      } catch (e) {
        console.log("Error cleaning up:", e);
      }

      try {
        await subscription.cleanup();
      } catch (e) {
        console.log("Error cleaning up:", e);
      }
    };

    const handleAbort = () => {
      if (!signal.aborted) return false;
      finish(new Error("Dropbox setup aborted"));
      return true;
    };

    const finish = async (err) => {
      if (finished) return;
      finished = true;
      await cleanup();
      done(err, callback);
    };

    try {
      await subscription.setupPromise;

      folder.status("Loading Dropbox account");
      account = await getAccount(account);
      if (handleAbort()) return;
      session.save();

      folder.status("Creating folder in Dropbox");
      account = await createFolder(account, signal);
      if (handleAbort()) return;
      session.save();

      await set(account.blog.id, {
        account_id: account.account_id,
        email: account.email,
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        full_access: account.full_access,
        folder: account.folder,
        folder_id: account.folder_id,
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

      folder.status("Syncing your folder to Dropbox");
      if (handleAbort()) return;

      // upload folder contents to dropbox
      // todo: pass in signal
      await resetFromBlot(account.blog.id, folder.status, signal);

      if (handleAbort()) return;
    } catch (err) {
      if (err && err.name === "AbortError") {
        folder.status("Dropbox setup aborted");
        if (abortHandled) return;
        signal.aborted = true;
        return handleAbort();
      }

      folder.status("Error: " + err.message);
      return finish(err);
    }

    finish(null);
  });
}

module.exports = setup;
