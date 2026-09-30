const express = require("express");
const site = express.Router();
const crypto = require("crypto");
const config = require("config");
const debug = require("debug")("blot:clients:github:routes");

// GitHub POSTs push/installation/repository events here for every
// installation of the app. Verify the HMAC-SHA256 signature against the
// raw body before parsing it, then respond 200 immediately - GitHub
// retries failed deliveries, so slow handling here risks duplicate
// events. See PLAN.md, "Webhook listening".
//
// Handling the events themselves (looking up the blog, downloading
// changed blobs, updating the folder) is added once the Redis schema
// exists to map a repository back to a blog.
site.post("/webhook", function (req, res) {
  if (config.maintenance) return res.sendStatus(503);

  const secret = config.github.webhook_secret;
  const signature = req.headers["x-hub-signature-256"] || "";

  if (!secret) return res.sendStatus(503);

  let data = "";

  req.setEncoding("utf8");

  req.on("data", function (chunk) {
    data += chunk;
  });

  req.on("end", function () {
    const digest =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(data).digest("hex");

    const expected = Buffer.from(digest);
    const actual = Buffer.from(signature);

    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      debug("Rejected webhook with invalid signature");
      return res.sendStatus(403);
    }

    debug("Received", req.headers["x-github-event"], "event");

    res.sendStatus(200);
  });
});

module.exports = site;
