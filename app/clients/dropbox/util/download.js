const fs = require("fs-extra");
const uuid = require("uuid/v4");
const clfdate = require("helper/clfdate");
const promisify = require("util").promisify;
const setMtime = promisify(require("./setMtime"));
const retry = require("./retry");
const callOnce = require("helper/callOnce");

const TIMEOUT = 30 * 1000; // 30 seconds
const {
  MAX_FILE_SIZE,
  hasUnsupportedExtension,
  exceedsFilesystemPathLimits,
} = require("./constants");

async function download(client, source, destination, callback) {
  const id = uuid();
  const prefix = () =>
    clfdate() + " clients:dropbox:download:" + id.slice(0, 6);
  let timedOut = false;

  console.log(prefix(), source, "->", destination);

  // The destination path can never become writeable between attempts, so
  // check it locally before fetching anything from Dropbox. Without this,
  // we'd download the full file every time only to fail on fs.outputFile.
  if (exceedsFilesystemPathLimits(destination)) {
    console.log(
      prefix(),
      "destination exceeds filesystem name/path limit, skipping download",
      destination
    );
    const err = new Error("Destination path exceeds filesystem limit");
    err.code = "ENAMETOOLONG";
    return callback(err);
  }

  const timeout = setTimeout(function () {
    timedOut = true;
    console.log(prefix(), "reached timeout for download");
    cleanup(new Error("Timeout reached for download"));
  }, TIMEOUT);

  // Otherwise the timeout triggers a double callback
  const cleanup = callOnce(function (err) {
    clearTimeout(timeout);
    console.log(prefix(), "calling back with err = ", err);
    callback(err);
  });

  try {
    const { result: metadata } = await client.filesGetMetadata({ path: source });
    if (timedOut) return;

    const metadataPath = metadata.path_display || source;

    if (hasUnsupportedExtension(metadataPath)) {
      console.log(
        prefix(),
        "skipping download because file extension is unsupported",
        metadataPath
      );
      await fs.outputFile(destination, "");
      if (timedOut) return;
      if (metadata.client_modified) {
        await setMtime(destination, metadata.client_modified);
        if (timedOut) return;
      }
      return cleanup();
    }

    if (metadata.size > MAX_FILE_SIZE) {
      console.log(
        prefix(),
        "skipping download because file exceeds size limit",
        metadata.size,
        ">",
        MAX_FILE_SIZE
      );
      await fs.outputFile(destination, "");
      if (timedOut) return;
      await setMtime(destination, metadata.client_modified);
      if (timedOut) return;
      return cleanup();
    }

    const { result } = await client.filesDownload({ path: source });
    if (timedOut) return;
    await fs.outputFile(destination, result.fileBinary);
    if (timedOut) return;
    await setMtime(destination, result.client_modified);
    if (timedOut) return;
  } catch (err) {
    return cleanup(err);
  }

  if (timedOut) return;
  cleanup();
}

module.exports = retry(download);
