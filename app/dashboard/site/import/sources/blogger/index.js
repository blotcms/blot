const lifecycle = require("dashboard/site/import/lifecycle");
const async = require("async");
const fs = require("fs-extra");
const helper = require("dashboard/site/import/helper");
const parse = require("./parse");

function processEntry(entry, outputDirectory) {
  return new Promise((resolve, reject) => {
    async.waterfall(
      [
        (next) => next(null, entry),
        helper.determine_path(outputDirectory),
        helper.download_pdfs,
        helper.download_images,
        helper.convert_to_markdown,
        helper.insert_metadata,
        helper.write,
      ].map(lifecycle.guard),
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function importBlogger(sourceFile, outputDirectory, status, siteHost) {
  status = typeof status === "function" ? status : () => {};
  await fs.emptyDir(outputDirectory);
  status("Reading Blogger export");
  const entries = await parse(await fs.readFile(sourceFile, "utf8"), siteHost);

  if (!entries.length) {
    throw new Error("No published posts or pages found in this Blogger export.");
  }
  for (let index = 0; index < entries.length; index++) {
    lifecycle.check();
    status(
      `(${index + 1}/${entries.length}) Processing ${entries[index].title}`
    );
    await processEntry(entries[index], outputDirectory);
  }

  return entries.length;
}

// Supports both the dashboard's callback lifecycle and direct Promise use.
// Options: { siteHost } — optional hostname used to rebase same-site links.
module.exports = function main(sourceFile, outputDirectory, status, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};

  const promise = importBlogger(
    sourceFile,
    outputDirectory,
    status,
    options.siteHost
  );
  if (typeof callback === "function") {
    promise.then((count) => callback(null, count), callback);
    return;
  }
  return promise;
};

module.exports.parse = parse;
module.exports.parseSiteHost = parse.parseSiteHost;
