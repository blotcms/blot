const database = require("../database");
const disconnect = require("../disconnect");
const express = require("express");
const fetch = require("../util/rateLimitedFetchWithRetriesAndTimeout");
const normalizeSharingLink = require("../util/normalizeSharingLink");
const setupState = require("../util/setupState");
const initialTransfer = require("../sync/initialTransfer");
const dashboard = new express.Router();
const parseBody = require("helper/bodyParser").urlencoded({ extended: false });
const config = require("config"); // For accessing configuration values
const establishSyncLock = require("sync/establishSyncLock");
const seize = require("sync/seize");
const { handleSyncLockError } = require("./lock");
const setClient = require("clients/util/setClient");
const health = require("clients/health");
const { SETUP_FAILED, isSetupInProgress } = require("../error");
const storageFolder = require("storage/folder");

const VIEWS = require("path").resolve(__dirname + "/../views") + "/";

// Whether the site has a file for setup to copy to iCloud: stops at the
// first one, so it's quick however big the folder is. Asked when the link
// is sent, since the setup later brings the iCloud folder's own files in
const hasFilesToCopy = async (blogID) => {
  for await (const _ of storageFolder.walk(blogID, "/")) return true;
  return false;
};

const MACSERVER_URL = config.icloud.server_address; // The Macserver base URL from config
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config

dashboard.use(async function (req, res, next) {
  try {
    res.locals.account = await database.get(req.blog.id);
    next();
  } catch (error) {
    next(error);
  }
});

// The iCloud page: a checklist while setting up (util/setupState.js), the
// folder's status once it is done. options as for setupState.
const render = (req, res, options = {}) => {
  const account = res.locals.account || null;

  res.locals.blotiCloudAccount = config.icloud.email;
  res.locals.setup = setupState(
    account,
    Object.assign({ email: config.icloud.email }, options)
  );

  // The health read before this route ran may predate the write that began
  // a new setup attempt, so don't show its stale error beside the progress.
  if (
    account &&
    isSetupInProgress(account) &&
    !health.isPaused(res.locals.blog.health)
  ) {
    res.locals.blog.healthIssue = undefined;
    res.locals.blog.health = health.syncing();
  }

  res.render(VIEWS + "index");
};

dashboard.get("/", function (req, res) {
  render(req, res);
});

// Older links: the checklist starts on the page itself now
dashboard.get("/connect", function (req, res) {
  res.redirect(req.baseUrl);
});

// Steps 1 and 2 again: to retry, to share a new folder after the old one went
// missing, or to change the folder
dashboard.get("/setup", function (req, res) {
  render(req, res, { share: true });
});

dashboard
  .route("/disconnect")
  .get(function (req, res) {
    res.render(VIEWS + "disconnect");
  })
  .post(async function (req, res, next) {
    let warning;

    try {
      warning = await disconnect(req.blog.id);
    } catch (err) {
      return next(err);
    }

    if (warning) {
      return res.message(
        req.baseUrl,
        "Disconnected from iCloud. Blot's copy of the folder on its Mac will be removed within a day."
      );
    }

    res.message(req.baseUrl, "Disconnected from iCloud");
  });

dashboard
  .route("/set-up-folder")
  .post(parseBody, async function (req, res, next) {
    try {
      if (req.body.cancel) {
        if (!req.blog.client) {
          return res.redirect(res.locals.dashboardBase + "/client");
        }

        try {
          await disconnect(req.blog.id);
        } catch (disconnectError) {
          return next(disconnectError);
        }

        return res.redirect(res.locals.dashboardBase + "/client");
      }

      const blogID = req.blog.id;
      const pasted =
        typeof req.body.sharingLink === "string" ? req.body.sharingLink : "";
      const blotiCloudAccount = config.icloud.email;

      // Check the link before anything changes, so a mistyped link leaves
      // the site as it was, and say what's wrong beside the box with the
      // pasted text still in it
      if (!pasted.trim()) {
        res.status(400);
        return render(req, res, { linkError: "empty", sharingLink: "" });
      }

      const sharingLink = normalizeSharingLink(pasted);

      if (!sharingLink) {
        res.status(400);
        return render(req, res, {
          linkError: "format",
          sharingLink: pasted.trim(),
        });
      }

      try {
        await setClient(req.blog, "icloud");
      } catch (setClientError) {
        return next(setClientError);
      }

      // If a setup for this exact link is already under way, don't start a
      // second Macserver run – it would race the first and can clobber its
      // result. The window lets a genuinely stuck setup be retried.
      const existing = await database.get(blogID);
      if (
        existing &&
        existing.sharingLink === sharingLink &&
        !existing.error &&
        !existing.setupComplete &&
        existing.setupStartedAt &&
        Date.now() - existing.setupStartedAt < 1000 * 90
      ) {
        console.log(
          `Setup already in progress for blogID: ${blogID}, ignoring duplicate request`
        );
        return res.redirect(req.baseUrl);
      }

      // The checklist leaves out "Copying your site's files" with nothing to
      // copy. If the check fails, the step shows as before
      const nothingToCopy = !(await hasFilesToCopy(blogID).catch(() => true));

      await database.store(blogID, {
        sharingLink,
        blotiCloudAccount,
        nothingToCopy,
        error: null,
        setupErrorReason: null,
        acceptedSharingLink: false,
        setupComplete: false,
        setupStartedAt: Date.now(),
      });

      // Seed the dashboard status line. The Macserver creates the folder
      // asynchronously and reports progress back via POST /status, which the
      // sync status line (SSE) surfaces to the user – see routes/site/status.js
      // and clients/icloud/sync/initialTransfer.js.
      const { folder, done } = await establishSyncLock(blogID);
      folder.status("Setting up your iCloud folder");
      await done();

      // Ask the Macserver to begin setup. This returns as soon as the request
      // has been accepted (202) – it does NOT wait for the folder to be
      // created, so the timeout here only needs to cover the acknowledgement.
      // The outcome arrives later via POST /status.
      console.log(`Sending setup request to Macserver for blogID: ${blogID}`);
      try {
        await fetch(`${MACSERVER_URL}/setup`, {
          method: "POST",
          timeout: 1000 * 15, // 15 seconds to acknowledge the request
          retries: 1, // don't retry: /setup is not idempotent
          headers: {
            "Content-Type": "application/json",
            Authorization: MACSERVER_AUTH, // Use the Macserver Authorization header
            blogID: blogID,
            sharingLink: sharingLink || "", // Include the sharingLink header, even if empty
          },
        });
      } catch (error) {
        console.error(
          `Macserver /setup request failed for blogID: ${blogID}`,
          error
        );
        // Surface the failure on the dashboard so the user can retry.
        const message =
          "Couldn't reach the setup server, please try again in a moment";
        try {
          await database.store(blogID, {
            error: message,
            errorCode: SETUP_FAILED,
          });
          const { folder, done } = await establishSyncLock(blogID);
          folder.status("Error: " + message);
          await done();
        } catch (statusError) {
          console.error(
            `Error recording setup failure for blogID ${blogID}: ${statusError.message}`
          );
        }
        // The checklist shows the stored error with the link still in the box
        return res.redirect(req.baseUrl);
      }

      console.log(`Macserver accepted setup request for blogID: ${blogID}`);

      // Redirect back to the dashboard – the status line takes it from here.
      res.redirect(req.baseUrl);
    } catch (error) {
      if (
        handleSyncLockError({
          err: error,
          res,
          blogID: req.blog.id,
          action: "setup folder",
        })
      ) {
        return;
      }

      console.error("Error in /set-up-folder:", error);
      next(error); // Pass the error to the error handler
    }
  });

// Copy the site's files into a folder Blot already joined, after that copy
// failed. Setting up again wouldn't help: the macserver already has the
// folder, so accepting the same link again brings no new folder to claim
dashboard.post("/retry-transfer", async function (req, res) {
  const account = res.locals.account;

  if (
    !account ||
    account.acceptedSharingLink !== true ||
    account.setupComplete === true
  ) {
    return res.redirect(req.baseUrl);
  }

  res.redirect(req.baseUrl);

  // It takes the sync lock and records its own progress and failure, which
  // the checklist shows
  try {
    await initialTransfer(req.blog.id);
  } catch (error) {
    console.error(
      `iCloud transfer retry failed for blogID: ${req.blog.id}`,
      error.message
    );
  }
});

dashboard.post("/cancel", async function (req, res, next) {
  try {
    // The Mac server stops setting up or watching the folder first. Then,
    // under the folder lock, taken from a transfer still running, which is
    // stopped and so can't write the account back (sync/seize.js)
    await disconnect.notifyMacserver(req.blog.id);
    await seize(req.blog.id, () => database.delete(req.blog.id), {
      reason: "disconnect",
    });

    res.message(req.baseUrl, "Cancelled the creation of your new folder");
  } catch (error) {
    next(error);
  }
});

module.exports = dashboard;
