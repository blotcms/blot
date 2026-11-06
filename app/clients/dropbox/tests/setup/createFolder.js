var { v4: uuid } = require("uuid");
var retry = require("clients/dropbox/util/retry");
module.exports = function (client, options, callback) {
  if (options.root) {
    return callback();
  }

  var create = retry(Create);

  create(client).then(function ([folder, folderID]) {
    callback(null, folder, folderID);
  }, callback);
};

async function Create(client) {
  var path = "/" + uuid();

  try {
    const { result } = await client.filesCreateFolder({ path: path });
    return [result.path_display, result.id];
  } catch (err) {
    console.log(err);
    throw new Error("Could not set up test folder", { cause: err });
  }
}
