const clfdate = require("helper/clfdate");
const { getMetadata, writeToFolder } = require("models/template");

module.exports = async function writeChangeToFolder(blog, template, view) {
  console.log(
    clfdate(),
    "writeChangeToFolder",
    blog.id,
    template.id,
    view.name
  );

  const ensureMetadata = async (metadata) => {
    if (!metadata || !metadata.localEditing) {
      console.log(clfdate(), "writeChangeToFolder", "No local editing");
      return;
    }

    console.log(clfdate(), "writeChangeToFolder", "Writing to folder");
    await writeToFolder(blog.id, metadata.id || template.id);
  };

  if (template && template.localEditing) {
    return ensureMetadata(template);
  }

  const metadata = await getMetadata(template.id);
  return ensureMetadata(metadata || template);
};
