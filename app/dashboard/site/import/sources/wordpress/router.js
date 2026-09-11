const express = require("express");
const Importer = express.Router();

const fs = require("fs-extra");
const { join } = require("path");

const init = require("dashboard/site/import/init");
const normalizeIdentifier = require(
  "dashboard/site/import/helper/normalize_identifier"
);

const wordpress = require("./index");

Importer.route("/wordpress")
  .get(function (req, res) {
    res.locals.breadcrumbs.add("WordPress", "wordpress");
    res.render("dashboard/import/wordpress");
  })
  .post(function (req, res) {
    const exportUpload =
      req.files &&
      Array.isArray(req.files.exportUpload) &&
      req.files.exportUpload[0];

    if (!exportUpload || !exportUpload.path) {
      return res.message(
        req.baseUrl + "/wordpress",
        new Error("Please select a WordPress export file.")
      );
    }

    const job = init({
      blogID: req.blog.id,
      label: "WordPress",
    });

    const { importDirectory, outputDirectory, status } = job;
    const releaseUpload = req.retainUpload
      ? req.retainUpload(exportUpload)
      : () => fs.remove(exportUpload.path);
    res.message(req.baseUrl, "Began import");

    const identifier = normalizeIdentifier(exportUpload.originalFilename, {
      extension: ".xml",
      fallback: "WordPress export",
    });
    const inputXML = exportUpload.path;

    job.run(async () => {
      await fs.outputFile(join(importDirectory, "identifier.txt"), identifier, "utf8");
      await new Promise((resolve, reject) => {
        wordpress(inputXML, outputDirectory, status, {}, err => err ? reject(err) : resolve());
      });
    }).catch(error => console.error("Failed to clean up import", error))
      .finally(() => releaseUpload())
      .catch(error => console.error("Failed to remove import upload", error));

  });

module.exports = Importer;
