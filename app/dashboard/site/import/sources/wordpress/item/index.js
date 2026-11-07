const lifecycle = require("dashboard/site/import/lifecycle");
var helper = require("dashboard/site/import/helper");
var extract_entry = require("./extract_entry");
var tidy = require("./tidy");
var withCallback = require("helper/withCallback");

// Runs one callback-style import step on the value, as a promise. The
// first step has no value to take.
function callStep(step, ...args) {
  return new Promise((resolve, reject) =>
    step(...args, (err, result) => (err ? reject(err) : resolve(result)))
  );
}

async function processItem(item, output_directory, write) {
  // Filter out items which should not become posts or pages
  if (
    item["wp:post_type"][0] === "nav_menu_item" ||
    item["wp:post_type"][0] === "attachment" ||
    item["wp:post_type"][0] === "feedback"
  ) {
    return;
  }

  try {
    lifecycle.check();
    let entry = await callStep(extract_entry(item));

    for (const step of [
      tidy,
      helper.determine_path(output_directory),
      helper.download_pdfs,
      helper.download_images,
      helper.convert_to_markdown,
      helper.insert_metadata,
      write,
    ]) {
      lifecycle.check();
      entry = await callStep(step, entry);
    }
  } catch (err) {
    err.message = `Failed to import ${(item.title && item.title[0]) || "WordPress item"}: ${err.message}`;
    throw err;
  }
}

const bridged = withCallback(processItem);

module.exports = function (item, output_directory, write, callback) {
  // Keep compatibility with callers which process a single item directly.
  if (!callback) {
    callback = write;
    write = helper.write;
  }
  return bridged(item, output_directory, write, callback);
};

module.exports.run = processItem;
