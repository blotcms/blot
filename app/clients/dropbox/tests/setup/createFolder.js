var { v4: uuid } = require("uuid");
var retry = require("clients/dropbox/util/retry");
module.exports = function (client, options, callback) {
  if (options.root) {
    return callback();
  }

  var create = retry(Create);

  create(client, callback);
};

function Create(client, callback) {
  var path = "/" + uuid();
  client
    .filesCreateFolder({ path: path })
    .then(function ({ result }) {
      callback(null, result.path_display, result.id);
    })
    .catch(function (err) {
      console.log(err);
      callback(new Error("Could not set up test folder"));
    });
}
