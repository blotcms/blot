var retry = require("clients/dropbox/util/retry");
var createClient = require("clients/dropbox/util/createClient");

async function remove() {
  var client = createClient(process.env.BLOT_DROPBOX_TEST_ACCOUNT_APP_TOKEN);

  function checkBatchStatus(result) {
    return client.filesDeleteBatchCheck(result).then(function (res) {
      switch (res[".tag"]) {
        case "in_progress":
          return checkBatchStatus(result);
        case "complete":
          return Promise.resolve(res);
        default:
          return Promise.reject(new Error("Unknown response " + res));
      }
    });
  }

  function removeAllFiles(res) {
    return client.filesDeleteBatch({
      entries: res.entries.map(function (entry) {
        return { path: entry.path_display };
      }),
    });
  }

  try {
    const res = await client
      .filesListFolder({ path: "" })
      .then(removeAllFiles)
      .then(checkBatchStatus);

    if (
      res.entries.some(function (entry) {
        return entry[".tag"] !== "success";
      })
    ) {
      return remove();
    }
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    } else {
      throw new Error(err, { cause: err });
    }
  }
}

module.exports = retry(remove);
