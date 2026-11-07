const lifecycle = require("dashboard/site/import/lifecycle");
const fs = require("fs-extra");
const helper = require("dashboard/site/import/helper");
const parse = require("./parse");

async function processEntry(entry, outputDirectory) {
  lifecycle.check();
  entry = await helper.determine_path(outputDirectory)(entry);
  lifecycle.check();
  entry = await helper.download_pdfs(entry);
  lifecycle.check();
  entry = await helper.download_images(entry);
  lifecycle.check();
  entry = await helper.convert_to_markdown(entry);
  lifecycle.check();
  entry = await helper.insert_metadata(entry);
  lifecycle.check();
  await helper.write(entry);
}

async function importBlogger(sourceFile, outputDirectory, status, siteHost) {
  status = typeof status === "function" ? status : () => {};
  await fs.emptyDir(outputDirectory);
  status("Reading Blogger export");
  const entries = await parse(await fs.readFile(sourceFile, "utf8"), siteHost);

  if (!entries.length) {
    throw new Error(
      "No published posts or pages found in this Blogger export."
    );
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

// Options: { siteHost } — optional hostname used to rebase same-site links.
module.exports = function main(
  sourceFile,
  outputDirectory,
  status,
  options = {}
) {
  return importBlogger(sourceFile, outputDirectory, status, options.siteHost);
};

module.exports.parse = parse;
module.exports.parseSiteHost = parse.parseSiteHost;
