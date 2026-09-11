const express = require("express");
const Import = express.Router();
const { join } = require("path");
const tempDir = require("helper/tempDir")();
const fs = require("fs-extra");
const list = require("./list");
const sse = require("helper/sse")({ channel: (req) => `import:status:${req.blog.id}` });

Import.use((req, res, next) => {
  res.locals.importBase = res.locals.base + "/import";
  res.locals.breadcrumbs.add("Import", "import");
  next();
});

Import.param("importID", async (req, res, next) => {
  const blogImportDirectory = await fs.realpath(
    join(tempDir, "import", req.blog.id)
  );

  const userSuppliedImportDirectory = await fs.realpath(
    join(tempDir, "import", req.blog.id, req.params.importID)
  );

  if (!userSuppliedImportDirectory.startsWith(blogImportDirectory)) {
    return next(new Error("Invalid import"));
  }

  req.importDirectory = userSuppliedImportDirectory;
  next();
});

Import.get("/", list, (req, res) => {
  res.render("dashboard/import");
});

Import.get("/status", sse);

Import.get("/download/:importID", async function (req, res, next) {
  try {
    const resultZip = join(req.importDirectory, "result.zip");

    let identifier = req.params.importID;

    try {
      identifier = await fs.readFile(
        join(req.importDirectory, "identifier.txt"),
        "utf-8"
      );
    } catch (e) {}

    if (fs.existsSync(join(req.importDirectory, "cancelled.txt"))) {
      return next(new Error("Import was cancelled"));
    }

    if (!fs.existsSync(resultZip)) {
      return next(new Error("Result zip does not exist"));
    }

    // Adds a name for the output file
    res.attachment(identifier + ".zip");
    fs.createReadStream(resultZip).pipe(res);
  } catch (e) {
    return next(new Error("Failed to download import"));
  }
});

Import.post("/cancel/:importID", async function (req, res) {
  try {
    await require("./lifecycle").cancel(req.importDirectory);
  } catch (e) {
    return res.message(req.baseUrl, new Error("Failed to cancel import"));
  }

  res.message(req.baseUrl, "Cancelled import");
});

Import.post("/delete/:importID", async function (req, res) {
  try {
    if (!(await require("./lifecycle").remove(req.importDirectory))) {
      return res.message(req.baseUrl, "Cancellation requested; remove the import after it stops");
    }
  } catch (e) {
    return res.message(req.baseUrl, new Error("Failed to remove import"));
  }

  res.message(req.baseUrl, "Removed import");
});

Import.use(require("./sources/arena/router"));
Import.use(require("./sources/wordpress/router"));
Import.use(require("./sources/squarespace/router"));
Import.use(require("./sources/blogger/router"));

module.exports = Import;
