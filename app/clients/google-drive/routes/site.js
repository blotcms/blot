const config = require("config");
const clfdate = require("helper/clfdate");
const express = require("express");
const site = new express.Router();

const sync = require("clients/google-drive/sync");
const database = require("clients/google-drive/database");

// Blogs with a sync running as a result of a webhook in this process
const ongoingSyncs = new Set();

// Blogs which received a webhook while a sync was already running. The running
// sync may have already walked past the change which triggered the webhook, so
// we re-run the sync once the current one finishes. Multiple webhooks during
// one sync collapse into a single follow-up.
const pendingResyncs = new Set();

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
      // Blogs which are currently syncing get a follow-up sync queued
      // instead of a second concurrent sync
      if (ongoingSyncs.has(blogID)) {
        if (!pendingResyncs.has(blogID)) {
          console.log(
            `${clfdate()} Google Drive client: Webhook received mid-sync, queueing follow-up sync ${blogID}`
          );
        }
        pendingResyncs.add(blogID);
        return;
      }

      ongoingSyncs.add(blogID);

      try {
        console.log(`${clfdate()} Google Drive client: Syncing blog ${blogID}`);
        await runSync(blogID);
      } finally {
        ongoingSyncs.delete(blogID);
      }
    })
  );
}

async function runSync(blogID) {
  try {
    await sync(blogID);
  } catch (e) {
    console.error("Google Drive client:", e.message);
  }

  if (!pendingResyncs.has(blogID)) return;

  pendingResyncs.delete(blogID);
  console.log(
    `${clfdate()} Google Drive client: Running follow-up sync for webhook received mid-sync ${blogID}`
  );
  return runSync(blogID);
}

module.exports = site;
