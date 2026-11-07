const fs = require("fs-extra");

module.exports = async (output_directory, posts, options = {}) => {
  if (!options.preserve_output_directory) fs.emptyDirSync(output_directory);

  const determinePath = require("./determine_path")(output_directory);
  const write = require("./write").createWriter();

  for (const post of posts) {
    let result = await determinePath(post);
    result = await require("./download_audio")(result);
    result = await require("./download_pdfs")(result);
    result = await require("./download_images")(result);
    result = await require("./convert_to_markdown")(result);
    result = await require("./insert_metadata")(result);
    await write(result);
  }

  console.log("Done!");
  process.exit();
};
