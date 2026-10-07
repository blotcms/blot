const express = require("express");
const config = require("config"); // For accessing configuration values
const email = require("helper/email");
const notificationCap = require("../../util/notificationCap");

const maxFileSize = config.icloud.maxFileSize; // Maximum file size for iCloud uploads in bytes
const limit = `${maxFileSize / 1000000}mb`; // limit must be in the format '5mb'

const { resyncRecentlySynced } = require("../../init");
const site = new express.Router();

site.use(require("./middleware/authorize"));

site.use(express.json());

site.use(express.raw({ type: "application/octet-stream", limit })); // For handling binary data

// Ping endpoint
const notifyServerStarted = notificationCap({ max: 2 });
site.get("/started", async function (req, res) {
  res.sendStatus(200);

  try {
    const result = notifyServerStarted(
      "started",
      () => email.ICLOUD_SERVER_STARTED(),
      () => email.ICLOUD_SERVER_PANIC()
    );

    if (result === "suppressed") {
      console.log("iCloud server restart: not sending any more notifications");
    }
  } catch (error) {
    console.error("Error handling /started notification:", error);
    if (!res.headersSent) {
      res.status(500).send("Failed to process /started notification");
    }
  }
});

// For the rest of the middleware, check that the blog is connected to iCloud
// and load the account status
site.use(require("./middleware/loadAccount"));

site.post("/status", require("./status"));

// For the rest of the middleware, which modify the folder state,
// check that the blog has finished setup, i.e. it is not in the
// process of transferring the initial folder state from Blot to iCloud
site.use(require("./middleware/ensureTransferComplete"));

site.post("/upload", require("./upload"));
site.post("/delete", require("./delete"));
site.post("/mkdir", require("./mkdir"));

module.exports = site;
