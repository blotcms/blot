const key = require("./key");
const client = require("models/client");
const getMetadata = require("./getMetadata");
const getView = require("./getView");
const updateCdnManifest = require("./util/updateCdnManifest");
const cacheID = require("./util/cacheID");

module.exports = function dropView(templateID, viewName, callback) {
  const multi = client.multi();

  getMetadata(templateID, function (err, metadata) {
    if (err) return callback(err);

    getView(templateID, viewName, function (viewErr, view) {
      if (viewErr) return callback(viewErr);

      multi.del(key.view(templateID, viewName));
      multi.hDel(key.urlPatterns(templateID), viewName);
      multi.sRem(key.allViews(templateID), viewName);
      multi.hSet(key.metadata(templateID), "cacheID", cacheID.create());

      if (view) {
        multi.del(key.url(templateID, view.url));
        multi.del(key.view(templateID, view.name));
      }

      multi
        .exec()
        .then(function () {
          cacheID.bumpBlogIfInstalled(
            metadata.owner,
            templateID,
            function (cacheErr) {
              if (cacheErr) return callback(cacheErr);

              updateCdnManifest(templateID, function (manifestErr) {
                if (manifestErr) return callback(manifestErr);

                callback(null, "Deleted " + templateID);
              });
            }
          );
        })
        .catch(callback);
    });
  });
};
