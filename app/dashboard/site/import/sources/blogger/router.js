const express = require("express");
const fs = require("fs-extra");
const { extname, join } = require("path");

const init = require("dashboard/site/import/init");
const normalizeIdentifier = require(
  "dashboard/site/import/helper/normalize_identifier"
);
const blogger = require("./index");

const Importer = express.Router();
function isBloggerExport(upload) {
  const extension = extname(upload.originalFilename || "").toLowerCase();
  const contentType = String(
    upload.headers && upload.headers["content-type"]
      ? upload.headers["content-type"]
      : upload.mimetype || ""
  )
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  return extension === ".atom" || contentType === "application/atom+xml";
}

Importer.route("/blogger")
  .get(function (req, res) {
    res.locals.breadcrumbs.add("Blogger", "blogger");
    res.render("dashboard/import/blogger");
  })
  .post(function (req, res) {
    const upload =
      req.files &&
      Array.isArray(req.files.exportUpload) &&
      req.files.exportUpload[0];

    if (!upload || !upload.path) {
      return res.message(
        req.baseUrl + "/blogger",
        new Error("Please select a Blogger export file.")
      );
    }

    if (!isBloggerExport(upload)) {
      fs.remove(upload.path).catch(() => {});
      return res.message(
        req.baseUrl + "/blogger",
        new Error("Please upload an Atom file exported from Blogger.")
      );
    }

    let siteHost = "";
    try {
      siteHost = blogger.parseSiteHost(req.body && req.body.siteURL);
    } catch (error) {
      fs.remove(upload.path).catch(() => {});
      return res.message(req.baseUrl + "/blogger", error);
    }

    const job = init({ blogID: req.blog.id, label: "Blogger" });
    const releaseUpload = req.retainUpload
      ? req.retainUpload(upload)
      : () => fs.remove(upload.path);
    res.message(req.baseUrl, "Began import");

    job.run(async () => {
      await fs.outputFile(
        join(job.importDirectory, "identifier.txt"),
        normalizeIdentifier(upload.originalFilename, {
          extension: ".atom",
          fallback: "Blogger export",
        }),
        "utf8"
      );
      await blogger(upload.path, job.outputDirectory, job.status, { siteHost });
    }).catch(error => console.error("Failed to clean up import", error))
      .finally(() => releaseUpload())
      .catch(error => console.error("Failed to remove Blogger upload", error));

  });

module.exports = Importer;
