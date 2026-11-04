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
};

async function uploadInChunks(client, source, destination, size, touch) {
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
    const start = await retryRequest(
      () => client.filesUploadSessionStart({ close: false, contents }),
      "uploadSessionStart"
    );
    const session_id = start.result.session_id;
    let offset = first;
    touch();

    while (size - offset > options.chunkSize) {
      contents = await read(offset, options.chunkSize);
      const cursor = { session_id, offset };
      await retryRequest(
        () =>
          client.filesUploadSessionAppendV2({ cursor, close: false, contents }),
        "uploadSessionAppend"
      );
      offset += contents.length;
      touch();
    }

    contents = await read(offset, size - offset);
    const cursor = { session_id, offset };
    await retryRequest(
      () =>
        client.filesUploadSessionFinish({
          cursor,
          commit: {
            path: destination,
            mode: { ".tag": "overwrite" },
            autorename: false,
          },
          contents,
        }),
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
  const touch = function () {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
      console.log(prefix(), "reached timeout for upload");
      cleanup(new Error("Timeout reached for upload"));
    }, 4 * 60 * 1000); // 4 minutes
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
      await uploadInChunks(client, source, destination, size, touch);
      return cleanup();
    }

    const contents = await fs.readFile(source);

    // client_modified is intentionally omitted: Blot doesn't keep a
    // provider-independent modified time for local files, so Dropbox
    // stamps the upload with its own server time instead.
    const { result } = await client.filesUpload({
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
