const folder = require("storage/folder");
const { v4: uuid } = require("uuid");
const clfdate = require("helper/clfdate");
const retry = require("./retry");

const TIMEOUT = 30 * 1000; // 30 seconds
const {
  MAX_FILE_SIZE,
  hasUnsupportedExtension,
  exceedsFilesystemPathLimits,
} = require("./constants");

async function download(client, source, blogID, destination) {
  const id = uuid();
  const prefix = () =>
    clfdate() + " clients:dropbox:download:" + id.slice(0, 6);
  let timedOut = false;

  console.log(prefix(), source, "->", destination);

  // The destination path can never become writeable between attempts, so
  // check it locally before fetching anything from Dropbox. Without this,
  // we'd download the full file every time only to fail on the write.
  if (exceedsFilesystemPathLimits(destination)) {
    console.log(
      prefix(),
      "destination exceeds filesystem name/path limit, skipping download",
      destination
    );
    const err = new Error("Destination path exceeds filesystem limit");
    err.code = "ENAMETOOLONG";
    throw err;
  }

  let timeout;
  const timeoutReached = new Promise(function (resolve, reject) {
    timeout = setTimeout(function () {
      timedOut = true;
      console.log(prefix(), "reached timeout for download");
      reject(new Error("Timeout reached for download"));
    }, TIMEOUT);
  });

  const transfer = (async function () {
    const { result: metadata } = await client.filesGetMetadata({
      path: source,
    });
    if (timedOut) return;

    const metadataPath = metadata.path_display || source;

    if (hasUnsupportedExtension(metadataPath)) {
      console.log(
        prefix(),
        "skipping download because file extension is unsupported",
        metadataPath
      );
      await folder.write(blogID, destination, "");
      return;
    }

    if (metadata.size > MAX_FILE_SIZE) {
      console.log(
        prefix(),
        "skipping download because file exceeds size limit",
        metadata.size,
        ">",
        MAX_FILE_SIZE
      );
      await folder.write(blogID, destination, "");
      return;
    }

    const { result } = await client.filesDownload({ path: source });
    if (timedOut) return;
    await folder.write(blogID, destination, result.fileBinary);
  })();

  // After a timeout the transfer is abandoned, and whatever it ends with
  // is not reported
  transfer.catch(function () {});

  let failure;

  try {
    await Promise.race([transfer, timeoutReached]);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    clearTimeout(timeout);
    console.log(prefix(), "calling back with err = ", failure);
  }
}

module.exports = retry(download);
