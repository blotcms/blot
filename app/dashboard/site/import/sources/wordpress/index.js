var fs = require("fs-extra");
var parseXMLAsync = require("util").promisify(require("xml2js").parseString);
var colors = require("colors/safe");
var Item = require("./item");
var helper = require("dashboard/site/import/helper");

async function main(sourceFile, outputDirectory, status, options) {
  fs.emptyDirSync(outputDirectory);

  status("Reading WordPress XML file");

  const xml = await fs.readFile(sourceFile, "utf-8");

  // Without strict:false, sometimes we run into errors with invalid/unescaped
  // characters in the XML provided by WordPress.
  // Strict seems to have some side-effects, which is why we also normalize:true
  // and normalizeTags:true.
  const result = await parseXMLAsync(xml, {
    strict: false,
    normalizeTags: true,
  });

  var channel, items, totalItems;

  try {
    channel = result.rss.channel[0];
    var link = channel && channel.link && channel.link[0];
    var exportVersion =
      channel && channel["wp:wxr_version"] && channel["wp:wxr_version"][0];

    console.log(colors.dim("Site URL:"), link);
    console.log(colors.dim("Export Version"), exportVersion);

    // If you want to see other properties available,
    // log this to STDOUT
    // console.log(result.rss.channel);

    if (options.filter) {
      console.log("filter by:", options.filter);
      channel.item = channel.item.filter(function (item) {
        return (
          item.title[0].toLowerCase().indexOf(options.filter.toLowerCase()) > -1
        );
      });
    }

    items = channel.item;

    totalItems = items.length;
  } catch (e) {
    throw new Error("Invalid XML", { cause: e });
  }

  // Final destinations are allocated only after downloads have established
  // whether an entry needs a directory-backed post.txt representation.
  var write = helper.write.createWriter();

  await importItems(items, channel, totalItems, outputDirectory, status, write);
}

async function importItems(
  items,
  channel,
  totalItems,
  outputDirectory,
  status,
  write
) {
  for (let index = 0; index < items.length; index++) {
    var item = items[index];

    require("../../lifecycle").check();

    var current = Number(index) + 1;
    var title = item.title[0].trim();

    status("(" + current + "/" + totalItems + ") Processing " + title);
    console.log(colors.dim(current + "/" + totalItems), title);
    injectAttachedThumbnail(item, channel.item);
    await Item.run(item, outputDirectory, write);
  }
}

// This will find 'attached' thumbnails that are not part of the
// body of the post itself, then add them to it.
function injectAttachedThumbnail(item, channel) {
  try {
    let thumbnail_id = item["wp:postmeta"].filter(
      (el) => el["wp:meta_key"] && el["wp:meta_key"][0] === "_thumbnail_id"
    )[0]["wp:meta_value"][0];

    let thumbnail = channel.filter((el) => {
      // console.log(el);
      return el["wp:post_id"][0] === thumbnail_id;
    })[0];

    let thumbnail_url = thumbnail.guid[0]._;
    let thumbnail_title = thumbnail.title[0] || thumbnail["content:encoded"][0];

    if (item["content:encoded"][0].indexOf(thumbnail_url) > -1) return;

    let new_html = `<img src="${thumbnail_url}" alt="${thumbnail_title}">`;

    if (item["content:encoded"][0].indexOf("<p>") > -1) {
      new_html = "<p>" + new_html + "</p>";
    }

    item["content:encoded"][0] = new_html + item["content:encoded"][0];
  } catch (e) {
    // do nothing if you can't find a thumbnail
  }
}

module.exports = main;
