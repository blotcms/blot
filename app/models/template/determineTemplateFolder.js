var folder = require("storage/folder");
var callbackify = require("util").callbackify;

function determineTemplateFolder(blogID, callback) {
  callbackify(folder.listAll)(blogID, "/", function (err, listing) {
    if (err || !Array.isArray(listing)) {
      return callback(null, "Templates");
    }

    var entries = listing.map(function (entry) {
      return entry.name;
    });

    if (entries.indexOf("Templates") > -1) return callback(null, "Templates");
    if (entries.indexOf("templates") > -1) return callback(null, "templates");

    var visible = entries.filter(function (name) {
      return name && name[0] !== ".";
    });

    if (visible.length && visible.every(function (name) {
      return name === name.toLowerCase();
    })) {
      return callback(null, "templates");
    }

    callback(null, "Templates");
  });
}

module.exports = determineTemplateFolder;
