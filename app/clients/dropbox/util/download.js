const folder = require("storage/folder");
const { extname } = require("path");
const { v4: uuid } = require("uuid");
const clfdate = require("helper/clfdate");
const crypto = require("crypto");
const retry = require("./retry");
const hashes = require("./hashes");

const TIMEOUT = 30 * 1000; // 30 seconds
const {
  MAX_FILE_SIZE,
  hasUnsupportedExtension,
  exceedsStorageLimits,
} = require("./constants");

// options.metadata is the file's { path_display, size } when the caller has
// them already (a delta entry carries both), which saves a filesGetMetadata
// call. Without it they are fetched.
//
// options.publish(fn) runs the step which writes into the blog's folder. The
// transfer from Dropbox is not serialised, but concurrent writes race in
// File.setMany (two siblings differing only in case lose a spelling from the
// lowercased-name index), so a caller downloading several files at once passes
// a publish which runs them one at a time. It defaults to calling fn.
//
// Resolves to the written file's { sha1, content_hash }, recorded in
// util/hashes.js so no walk has to hash it, or undefined if a placeholder was
// written instead.
//
// options.signal (the sync's folder.signal) gives the download up as the
// timeout does once it aborts, rejecting with its reason, and nothing is
// written after that. The client's own requests are cut off too when it was
// loaded with the signal (util/loadClient.js).
async function download(client, source, blogID, destination, options) {
  const id = uuid();
  const prefix = () =>
    clfdate() + " clients:dropbox:download:" + id.slice(0, 6);
  let timedOut = false;
  const publish = (options && options.publish) || ((fn) => fn());
  const signal = options && options.signal;

  if (signal) signal.throwIfAborted();

  console.log(prefix(), source, "->", destination);

  // The destination path can never become writeable between attempts, so
  // check it locally before fetching anything from Dropbox. Without this,
  // we'd download the full file every time only to fail on the write.
  if (exceedsStorageLimits(destination)) {
    console.log(
      prefix(),
      "destination exceeds the storage path limit, skipping download",
      destination
    );
    const err = new Error("Destination path exceeds the storage limit");
    err.code = "ENAMETOOLONG";
    throw err;
  }

  let timeout;
  let onAbort;
  const timeoutReached = new Promise(function (resolve, reject) {
    timeout = setTimeout(function () {
      timedOut = true;
      console.log(prefix(), "reached timeout for download");
      reject(new Error("Timeout reached for download"));
    }, TIMEOUT);

    if (!signal) return;
    onAbort = function () {
      timedOut = true;
      console.log(prefix(), "cancelled download");
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const transfer = (async function () {
    let metadata = options && options.metadata;

    if (!metadata) {
      ({ result: metadata } = await client.filesGetMetadata({
        path: source,
      }));
      if (timedOut) return;
    }

    const metadataPath = metadata.path_display || source;

    if (hasUnsupportedExtension(metadataPath)) {
      console.log(
        prefix(),
        "skipping download because file extension is unsupported",
        metadataPath
      );
      await publish(() =>
        folder.writePlaceholder(blogID, destination, {
          code: "SYNC_UNSUPPORTED",
          kind: extname(metadataPath).toLowerCase(),
        })
      );
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
      await publish(() =>
        folder.writePlaceholder(blogID, destination, {
          code: "SYNC_TOO_LARGE",
          size: metadata.size,
          limit: MAX_FILE_SIZE,
        })
      );
      return;
    }

    const { result } = await client.filesDownload({ path: source });
    if (timedOut) return;
    const written = await publish(async () => {
      // Not after the download was given up on, however long it waited
      if (timedOut) return;
      await folder.write(blogID, destination, result.fileBinary);
      return true;
    });
    if (!written) return;

    const pair = {
      sha1: crypto.createHash("sha1").update(result.fileBinary).digest("hex"),
      content_hash: result.content_hash,
    };
    await hashes.add(blogID, pair.sha1, pair.content_hash);
    return pair;
  })();

  // After a timeout the transfer is abandoned, and whatever it ends with
  // is not reported
  transfer.catch(function () {});

  let failure;

  try {
    return await Promise.race([transfer, timeoutReached]);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    console.log(prefix(), "calling back with err = ", failure);
  }
}

module.exports = retry(download);
