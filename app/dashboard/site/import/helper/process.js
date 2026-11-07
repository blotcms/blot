const fs = require("fs-extra");

// Runs one callback-style import step (helper/*) on the post, as a promise.
function callStep(step, post) {
  return new Promise((resolve, reject) =>
    step(post, (err, result) => (err ? reject(err) : resolve(result)))
  );
}

module.exports = (output_directory, posts, options = {}) => {
  if (!options.preserve_output_directory) fs.emptyDirSync(output_directory);

  const determinePath = require("./determine_path")(output_directory);
  const write = require("./write").createWriter();

  (async () => {
    for (const post of posts) {
      let result = await callStep(determinePath, post);
      result = await require("./download_audio")(result);
      result = await require("./download_pdfs")(result);
      result = await require("./download_images")(result);
      result = await callStep(require("./convert_to_markdown"), result);
      result = await callStep(require("./insert_metadata"), result);
      await callStep(write, result);
    }
  })().then(
    () => {
      console.log("Done!");
      process.exit();
    },
    (err) => {
      // Crash, as an error thrown from the callback did
      process.nextTick(() => {
        throw err;
      });
    }
  );
};
