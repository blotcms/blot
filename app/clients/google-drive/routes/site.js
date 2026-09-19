const config = require("config");
const clfdate = require("helper/clfdate");
const express = require("express");
const site = new express.Router();

const sync = require("clients/google-drive/sync");
const database = require("clients/google-drive/database");

site
  .route("/webhook/changes.watch/:serviceAccountId")
  .post(async function (req, res, next) {
    try {
      console.log(
        `${clfdate()} Google Drive client: Received changes.watch webhook for service account ${
          req.params.serviceAccountId
        }`
      );

      const blogIDs = [];

      await database.blog.iterateByServiceAccountId(
        req.params.serviceAccountId,
        async function (blogID, account) {
          blogIDs.push(blogID);
        }
      );

      if (!blogIDs.length) {
        console.log(
          `${clfdate()} Google Drive client: No blogs found for service account ${
            req.params.serviceAccountId
          }`
        );
        return res.sendStatus(200);
      }

      // sync all blogs in parallel but if one errors don't stop the others
      await Promise.all(
        blogIDs.map(async (blogID) => {
          try {
            console.log(
              `${clfdate()} Google Drive client: Syncing blog ${blogID}`
            );
            await sync(blogID);
          } catch (e) {
            console.error("Google Drive client:", e.message);
          }
        })
      );

      res.sendStatus(200);
    } catch (err) {
      next(err);
    }
  });

module.exports = site;
