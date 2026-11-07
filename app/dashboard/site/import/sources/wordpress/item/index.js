const lifecycle = require("dashboard/site/import/lifecycle");
var helper = require("dashboard/site/import/helper");
var extract_entry = require("./extract_entry");
var tidy = require("./tidy");

// Runs one callback-style import step on the value, as a promise. The
// first step has no value to take.
function callStep(step, ...args) {
  return new Promise((resolve, reject) =>
    step(...args, (err, result) => (err ? reject(err) : resolve(result)))
  );
}

async function processItem(item, output_directory, write = helper.write) {
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

    lifecycle.check();
    entry = await callStep(tidy, entry);
    lifecycle.check();
    entry = await callStep(helper.determine_path(output_directory), entry);
    lifecycle.check();
    entry = await helper.download_pdfs(entry);
    lifecycle.check();
    entry = await helper.download_images(entry);
    lifecycle.check();
    entry = await callStep(helper.convert_to_markdown, entry);
    lifecycle.check();
    entry = await callStep(helper.insert_metadata, entry);
    lifecycle.check();
    await callStep(write, entry);
  } catch (err) {
    err.message = `Failed to import ${(item.title && item.title[0]) || "WordPress item"}: ${err.message}`;
    throw err;
  }
}

module.exports = processItem;

module.exports.run = processItem;
