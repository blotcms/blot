var folder = require("storage/folder");

module.exports = async function determineTemplateFolder(blogID) {
  var listing;

  try {
    listing = await folder.listNames(blogID, "/");
  } catch (err) {
    return "Templates";
  }

  if (!Array.isArray(listing)) {
    return "Templates";
  }

  var entries = listing.map(function (entry) {
    return entry.name;
  });

  if (entries.indexOf("Templates") > -1) return "Templates";
  if (entries.indexOf("templates") > -1) return "templates";

  var visible = entries.filter(function (name) {
    return name && name[0] !== ".";
  });

  if (
    visible.length &&
    visible.every(function (name) {
      return name === name.toLowerCase();
    })
  ) {
    return "templates";
  }

  return "Templates";
};
