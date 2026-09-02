const clfdate = require("helper/clfdate");
const database = require("../database");
const disconnect = require("../disconnect");
const express = require("express");
const fetch = require("../util/rateLimitedFetchWithRetriesAndTimeout");
const dashboard = new express.Router();
const parseBody = require("body-parser").urlencoded({ extended: false });
const config = require("config"); // For accessing configuration values
const establishSyncLock = require("sync/establishSyncLock");
const { handleSyncLockError } = require("./lock");
const Blog = require("models/blog");

const VIEWS = require("path").resolve(__dirname + "/../views") + "/";

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

dashboard.get("/", function (req, res) {
  if (!res.locals.account) {
    return res.redirect(req.baseUrl + "/connect");
  }

  res.locals.blotiCloudAccount = config.icloud.email;
  res.render(VIEWS + "index");
});

dashboard.route("/connect").get(function (req, res) {
  res.render(VIEWS + "connect");
});

dashboard.route("/setup").get(function (req, res) {
  res.locals.blotiCloudAccount = config.icloud.email;
  res.render(VIEWS + "setup");
});

dashboard
  .route("/disconnect")
  .get(function (req, res) {
    res.render(VIEWS + "disconnect");
  })
  .post(function (req, res, next) {
    disconnect(req.blog.id, function (err, warning) {
      if (err) return next(err);

      if (warning) {
        return res.message(
          req.baseUrl,
          "Disconnected from iCloud. Remote cleanup will retry in the background."
        );
      }

      res.message(req.baseUrl, "Disconnected from iCloud");
    });
  });

dashboard
  .route("/set-up-folder")
  .post(parseBody, async function (req, res, next) {
    try {
      if (req.body.cancel) {
        if (!req.blog.client) {
          return res.redirect(res.locals.dashboardBase + "/client");
        }

        return disconnect(req.blog.id, next);
      }

      const setClientError = await new Promise((resolve) => {
        Blog.set(req.blog.id, { client: "icloud" }, function (err) {
          resolve(err);
        });
      });

      if (setClientError) {
        return next(setClientError);
      }

      const blogID = req.blog.id;
      const sharingLink = req.body.sharingLink;
      const blotiCloudAccount = req.body.blotiCloudAccount;

      // Store the sharingLink in the database if provided
      if (sharingLink) {
        // validate the sharing link format
        // it should look like: https://www.icloud.com/iclouddrive/08d83wAt2lMHc46hEEi0D5zcQ#example
        if (
          !/^https:\/\/www\.icloud\.com\/iclouddrive\/[a-zA-Z0-9_-]+#/.test(
            sharingLink
          )
        ) {
          return next(new Error("Invalid sharing link format"));
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

        await database.store(blogID, {
          sharingLink,
          blotiCloudAccount,
          error: null,
          setupComplete: false,
          setupStartedAt: Date.now(),
        });
      } else {
        return next(new Error("Paste the sharing link into the box"));
      }

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
          await database.store(blogID, { error: message });
          const { folder, done } = await establishSyncLock(blogID);
          folder.status("Error: " + message);
          await done();
        } catch (statusError) {
          console.error(
            `Error recording setup failure for blogID ${blogID}: ${statusError.message}`
          );
        }
        return next(new Error(message));
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

dashboard.post("/cancel", async function (req, res, next) {
  try {
    await database.delete(req.blog.id);

    res.message(req.baseUrl, "Cancelled the creation of your new folder");
  } catch (error) {
    next(error);
  }
});

module.exports = dashboard;
