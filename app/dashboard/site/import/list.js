const fs = require("fs-extra");
const moment = require("moment");
const prettySize = require("helper/prettySize");
const tempDir = require("helper/tempDir")();
const { join } = require("path");

// Lists all the imports for a given blog
module.exports = async function (req, res, next) {
  try {
    const imports = await fs.readdir(join(tempDir, "import", req.blog.id));

    res.locals.imports = imports
      .filter(i => !fs.existsSync(join(tempDir, "import", req.blog.id, i, "deleted.txt")))
      .map((i) => {
        let size;
        let started;
        let importedOn;
        let identifier;
        let name;
        let lastStatus;
        let error;
        let cancelled;
        let timestamp;

        try {
          size = prettySize(
            Math.round(
              fs.statSync(join(tempDir, "import", req.blog.id, i, "result.zip"))
                .size / 1000
            )
          , 0); // no decimals
        } catch (e) {}

        try {
          const lastDash = i.lastIndexOf("-");
          name = i.slice(0, lastDash);
          timestamp = parseInt(i.slice(lastDash + 1), 10);
          started = moment(timestamp).fromNow();
          importedOn = moment(timestamp).format("MMM D, YYYY");
        } catch (e) {}

        try {
          cancelled = fs.readFileSync(
            join(tempDir, "import", req.blog.id, i, "cancelled.txt"),
            "utf-8"
          );
        } catch (e) {}

        try {
          identifier = fs.readFileSync(
            join(tempDir, "import", req.blog.id, i, "identifier.txt"),
            "utf-8"
          );
        } catch (e) {}

        try {
          error = fs.readFileSync(
            join(tempDir, "import", req.blog.id, i, "error.txt"),
            "utf-8"
          );
        } catch (e) {}

        try {
          lastStatus = fs.readFileSync(
            join(tempDir, "import", req.blog.id, i, "status.txt"),
            "utf-8"
          );
        } catch (e) {}

        const leaseExpiry = require("./lifecycle").leaseExpiry(join(tempDir, "import", req.blog.id, i));
        if (leaseExpiry !== undefined && leaseExpiry <= Date.now()) {
          error = "Import worker stopped. Delete this import and try again.";
        }

        return {
          id: i,
          name,
          icon: name
            ? "/images/configure/" +
                (["blogger", "wordpress", "are.na", "squarespace"].includes(
                  name.toLowerCase()
                )
                  ? name.toLowerCase() + ".svg"
                  : name.toLowerCase() + ".png")
            : undefined,
          identifier,
          cancelled,
          size,
          error,
          lastStatus: cancelled ? (lastStatus === "Cancelled" ? "Cancelled" : "Cancelling") : (!!error ? error : lastStatus),
          started,
          importedOn,
          timestamp,
          complete: !!size || !!error || lastStatus === "Cancelled",
        };
      })
      .filter((i) => !!i && !!i.name);

      // sort by timestamp
      res.locals.imports.sort((a, b) => {
        return b.timestamp - a.timestamp;
      });
  } catch (e) {
    //
  }
  next();
};
