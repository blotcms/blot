const lifecycle = require("dashboard/site/import/lifecycle");
var helper = require("dashboard/site/import/helper");
var extract_entry = require("./extract_entry");
var tidy = require("./tidy");

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
    let entry = extract_entry(item);

    lifecycle.check();
    entry = tidy(entry);
    lifecycle.check();
    entry = await helper.determine_path(output_directory)(entry);
    lifecycle.check();
    entry = await helper.download_pdfs(entry);
    lifecycle.check();
    entry = await helper.download_images(entry);
    lifecycle.check();
    entry = await helper.convert_to_markdown(entry);
    lifecycle.check();
    entry = await helper.insert_metadata(entry);
    lifecycle.check();
    await write(entry);
  } catch (err) {
    err.message = `Failed to import ${(item.title && item.title[0]) || "WordPress item"}: ${err.message}`;
    throw err;
  }
}

module.exports = processItem;

module.exports.run = processItem;
