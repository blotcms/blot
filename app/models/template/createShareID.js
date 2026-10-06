var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var { v4: uuid } = require("uuid");

module.exports = function createShareID(templateID, callback) {
  getMetadata(templateID, function (err, template) {
    if (err) return callback(err);

    template.shareID = uuid();
    setMetadata(templateID, template, function (setErr) {
      if (setErr) return callback(setErr);

      client
        .set(key.share(template.shareID), templateID)
        .then(function () {
          callback(null, template.shareID);
        })
        .catch(callback);
    });
  });
};
