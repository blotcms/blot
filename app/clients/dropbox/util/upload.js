// TODO add a way to upload files larger than 150MB
// this will fail in that case:
// https://dropbox.github.io/dropbox-sdk-js/Dropbox.html#filesUpload__anchor

// todo: check client_modified is respected

const fs = require("fs-extra");
const retry = require("./retry");
const { v4: uuid } = require("uuid");
const clfdate = require("helper/clfdate");
const callOnce = require("helper/callOnce");

async function upload(client, source, destination, callback) {
  const id = uuid();
  const prefix = () => clfdate() + " clients:dropbox:upload:" + id.slice(0, 6);

  console.log(prefix(), source);

  const timeout = setTimeout(function () {
    console.log(prefix(), "reached timeout for upload");
    cleanup(new Error("Timeout reached for upload"));
  }, 4 * 60 * 1000); // 4 minutes

  const cleanup = callOnce(function (err) {
    clearTimeout(timeout);
    console.log(prefix(), "calling back with err = ", err);
    callback(err);
  });

  try {
    const contents = await fs.readFile(source);
    const { mtime } = await fs.stat(source);
    const mtimeString = mtime.toISOString();
    const mtimePeriodIndex = mtimeString.indexOf(".");

    // Dropbox doesn't like timestamps with the period
    const client_modified =
      mtimePeriodIndex === -1
        ? mtimeString
        : mtimeString.slice(0, mtimePeriodIndex) + "Z";

    const { result } = await client.filesUpload({
      path: destination,
      client_modified,
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
