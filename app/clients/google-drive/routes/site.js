const config = require("config");
const clfdate = require("helper/clfdate");
const express = require("express");
const site = new express.Router();

const sync = require("clients/google-drive/sync");
const database = require("clients/google-drive/database");
const followUpSync = require("clients/util/followUpSync");

// Syncs a blog, or leaves a follow-up for any process to run once a sync
// already running (here or in another container) has finished
const followUps = followUpSync("google-drive", function (blogID) {
  return sync(blogID, { rethrowLocked: true });
});

site
  .route("/webhook/changes.watch/:serviceAccountId")
  .post(async function (req, res, next) {
    const serviceAccountId = req.params.serviceAccountId;

    console.log(
      `${clfdate()} Google Drive client: Received changes.watch webhook for service account ${serviceAccountId}`
    );

    const blogIDs = [];

    // Look up the blogs before replying so a database failure reaches
    // next(err) and Google redelivers the notification
    try {
      await database.blog.iterateByServiceAccountId(
        serviceAccountId,
        async function (blogID, account) {
          blogIDs.push(blogID);
        }
      );
    } catch (err) {
      return next(err);
    }

    // Reply before syncing. Waiting for the syncs to finish meant Google hung
    // up (499) before we replied.
    res.sendStatus(200);

    if (!blogIDs.length) {
      console.log(
        `${clfdate()} Google Drive client: No blogs found for service account ${serviceAccountId}`
      );
      return;
    }

    syncBlogs(blogIDs).catch(function (err) {
      console.error(
        `${clfdate()} Google Drive client: Webhook error for service account ${serviceAccountId}:`,
        err.message
      );
    });
  });

async function syncBlogs(blogIDs) {
  // sync all blogs in parallel but if one errors don't stop the others
  await Promise.all(
    blogIDs.map(async (blogID) => {
      console.log(`${clfdate()} Google Drive client: Syncing blog ${blogID}`);
      try {
        await followUps.run(blogID);
      } catch (e) {
        console.error("Google Drive client:", e.message);
      }
    })
  );
}

module.exports = site;
