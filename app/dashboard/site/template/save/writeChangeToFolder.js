const clfdate = require("helper/clfdate");
const { getMetadata, writeToFolder } = require("models/template");

module.exports = function (blog, template, view, callback) {
  console.log(
    clfdate(),
    "writeChangeToFolder",
    blog.id,
    template.id,
    view.name
  );

  const ensureMetadata = (metadata) => {
    if (!metadata || !metadata.localEditing) {
      console.log(clfdate(), "writeChangeToFolder", "No local editing");
      return callback();
    }

    console.log(clfdate(), "writeChangeToFolder", "Writing to folder");
    writeToFolder(blog.id, metadata.id || template.id, callback);
  };

  if (template && template.localEditing) {
    return ensureMetadata(template);
  }

  getMetadata(template.id, function (err, metadata) {
    if (err) return callback(err);
    ensureMetadata(metadata || template);
  });
};
