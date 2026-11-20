const clfdate = require("helper/clfdate");
const express = require("express");
const site = new express.Router();

const database = require("clients/google-drive/database");
const followUps = require("clients/google-drive/sync/followUps");

// Google calls this (changes.watch, set up in serviceAccount/watchChanges.js)
// when anything the service account can see changes. The notification says
// nothing about what changed, so every blog on the account is synced: each
// sync walks its folder without the folder lock and takes the lock only if
// something differs (sync/index.js, #2847).
//
// The webhook is one change source of several, because on its own it is
// neither fast enough nor complete (trials on drivetest, 20 Nov 2026):
// - It usually arrives within 0.5s of Google's change time, but often enough
//   4-13s late: an append went live 12.8s after the change instead of about
//   3s. serviceAccount/readChanges.js reads changes.list every second, which
//   listed every change 0.3-1.1s after its change time, and syncs just the
//   directories that changed.
// - It can arrive a moment before changes.list has the change, so the walk it
//   starts finds nothing yet. changes.list then catches it.
// - Edits to a Google Doc open in a browser don't reach Drive's metadata for
//   about 2 minutes, so no webhook comes at all. serviceAccount/hotDocPoller.js
//   polls docs.documents.get for those (live 1.5-2.2s after typing).
// - Drive for desktop records two changes per edit, about 6s apart (the upload,
//   then the local modified time put back), so two webhooks.
// serviceAccount/searchEdits.js (a search for recent edits) and
// pollDriveActivity.js are further sources, and validate.js walks hourly.
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
