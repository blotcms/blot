// filesUpload is limited to 150MB, so larger files go through the upload
// session API (start / append / finish) in chunks, reading one chunk at a
// time from disk. Each API call is retried on transient errors; a failed
// session is not resumed across process restarts.
// https://www.dropbox.com/developers/documentation/http/documentation#files-upload_session-start

const fs = require("fs-extra");
const retry = require("./retry");
const { v4: uuid } = require("uuid");
const clfdate = require("helper/clfdate");
const callOnce = require("helper/callOnce");
const retryRequest = require("./retryRequest");

// Exported on upload.options so specs can shrink them.
const options = {
  threshold: 140 * 1024 * 1024,
  chunkSize: 8 * 1024 * 1024,
  timeout: 4 * 60 * 1000,
};

// A lost append response that is retried makes Dropbox answer 409 with the
// offset it already holds. The SDK error carries either the append error
// (".tag": "incorrect_offset") or a wrapped lookup error.
function incorrectOffset(err) {
  let body = err && err.error;
  if (body && body.error) body = body.error;
  if (body && body.lookup_failed) body = body.lookup_failed;
  if (body && body.upload_session_lookup_error)
    body = body.upload_session_lookup_error;
  if (
    body &&
    body[".tag"] === "incorrect_offset" &&
    typeof body.correct_offset === "number"
  )
    return body.correct_offset;
  return null;
}

async function uploadInChunks(
  client,
  source,
  destination,
  size,
  touch,
  isCancelled
) {
  const check = () => {
    if (isCancelled()) throw new Error("Upload cancelled after timeout");
  };
  const handle = await fs.open(source, "r");

  try {
    const read = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await fs.read(
          handle,
          buffer,
          filled,
          length - filled,
          offset + filled
        );
        if (!bytesRead) throw new Error("Unexpected end of file: " + source);
        filled += bytesRead;
      }
      return buffer;
    };

    const first = Math.min(options.chunkSize, size);
    let contents = await read(0, first);
    check();
    const start = await retryRequest(
      () => (check(), client.filesUploadSessionStart({ close: false, contents })),
      "uploadSessionStart"
    );
    const session_id = start.result.session_id;
    let offset = first;
    touch();

    while (size - offset > options.chunkSize) {
      contents = await read(offset, options.chunkSize);
      const cursor = { session_id, offset };
      try {
        await retryRequest(
          () => (
            check(),
            client.filesUploadSessionAppendV2({ cursor, close: false, contents })
          ),
          "uploadSessionAppend"
        );
        offset += contents.length;
      } catch (err) {
        const correct = incorrectOffset(err);
        if (correct === offset + contents.length) {
          // The first attempt reached Dropbox and only its response was lost.
          offset = correct;
        } else if (
          correct !== null &&
          correct !== offset &&
          correct > 0 &&
          correct < size
        ) {
          // Dropbox holds a different known offset: re-read from there.
          offset = correct;
        } else {
          throw err;
        }
      }
      touch();
    }

    contents = await read(offset, size - offset);
    const cursor = { session_id, offset };
    check();
    await retryRequest(
      () => (
        check(),
        client.filesUploadSessionFinish({
          cursor,
          commit: {
            path: destination,
            mode: { ".tag": "overwrite" },
            autorename: false,
          },
          contents,
        })
      ),
      "uploadSessionFinish"
    );
  } finally {
    await fs.close(handle);
  }
}

async function upload(client, source, destination, callback) {
  const id = uuid();
  const prefix = () => clfdate() + " clients:dropbox:upload:" + id.slice(0, 6);

  console.log(prefix(), source);

  // Restarted after each chunk of a large upload, so it limits a stall,
  // not the whole transfer.
  let timeout;
  let cancelled = false;
  const touch = function () {
    if (cancelled) return;
    clearTimeout(timeout);
    timeout = setTimeout(function () {
      console.log(prefix(), "reached timeout for upload");
      cancelled = true;
      cleanup(new Error("Timeout reached for upload"));
    }, options.timeout); // 4 minutes by default
  };
  touch();

  const cleanup = callOnce(function (err) {
    clearTimeout(timeout);
    console.log(prefix(), "calling back with err = ", err);
    callback(err);
  });

  try {
    const { size } = await fs.stat(source);

    if (size > options.threshold) {
      await uploadInChunks(client, source, destination, size, touch, () => cancelled);
      return cleanup();
    }

    const contents = await fs.readFile(source);

    // client_modified is intentionally omitted: Blot doesn't keep a
    // provider-independent modified time for local files, so Dropbox
    // stamps the upload with its own server time instead.
    await client.filesUpload({
      path: destination,
      mode: { ".tag": "overwrite" },
      autorename: false,
      contents,
    });
  } catch (err) {
    return cleanup(err);
  }

  cleanup();
}

module.exports = retry(upload);
module.exports.options = options;
