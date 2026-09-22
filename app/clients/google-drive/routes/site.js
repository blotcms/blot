const express = require("express");
const site = new express.Router();

// Service accounts are down. Acknowledge webhooks without syncing.
site.route("/webhook/changes.watch/:serviceAccountId").post(function (req, res) {
  res.sendStatus(200);
});

module.exports = site;
