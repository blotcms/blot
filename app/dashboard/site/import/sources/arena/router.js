const express = require("express");
const Importer = express.Router();
const arena = require("./index");
const init = require("dashboard/site/import/init");
const normalizeIdentifier = require(
  "dashboard/site/import/helper/normalize_identifier"
);
const fs = require("fs-extra");
const { join } = require("path");
const URL = require("url");
const download = require("../../helper/download");

Importer.get("/are.na", function (req, res) {
  res.redirect(req.baseUrl + "/arena");
});

Importer.route("/arena")
  .get(function (req, res) {
    res.locals.breadcrumbs.add("Are.na", "arena");
    res.render("dashboard/import/arena");
  })
  .post(async (req, res) => {
    let slug;

    try {
      const channelURL = new URL.URL(req.body && req.body.channel);
      const parts = channelURL.pathname.split("/").filter(Boolean);

      if (
        channelURL.protocol !== "https:" ||
        !["are.na", "www.are.na"].includes(channelURL.hostname) ||
        parts.length < 2
      ) {
        throw new Error("Invalid Are.na channel URL");
      }

      slug = parts[parts.length - 1];
    } catch (error) {
      return res.message(
        req.baseUrl + "/arena",
        new Error("Enter a valid public Are.na channel URL.")
      );
    }

    const job = init({
      blogID: req.blog.id,
      label: "Are.na",
    });

    const { importDirectory, outputDirectory, status } = job;
    res.message(req.baseUrl, "Began import");
    await job.run(async () => {
      const { data } = await download(`https://api.are.na/v2/channels/${slug}`);
      const { title } = JSON.parse(data.toString("utf8"));
      await fs.outputFile(
        join(importDirectory, "identifier.txt"),
        normalizeIdentifier(title, { fallback: "Are.na channel" }),
        "utf8"
      );
      await arena({ slug, outputDirectory, status });
    }).catch(error => console.error("Failed to clean up Are.na import", error));

  });

module.exports = Importer;
