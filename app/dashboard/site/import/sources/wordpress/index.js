var fs = require("fs-extra");
var async = require("async");
var parseXML = require("xml2js").parseString;
var colors = require("colors/safe");
var Item = require("./item");
var helper = require("dashboard/site/import/helper");

function main(sourceFile, outputDirectory, status, options, callback) {
  fs.emptyDirSync(outputDirectory);

  status("Reading WordPress XML file");

  fs.readFile(sourceFile, "utf-8", function (err, xml) {
    if (err) return callback(err);

    // Without strict:false, sometimes we run into errors with invalid/unescaped
    // characters in the XML provided by WordPress.
    // Strict seems to have some side-effects, which is why we also normalize:true
    // and normalizeTags:true.
    parseXML(xml, { strict: false, normalizeTags: true }, function (
      err,
      result
    ) {
      if (err) return callback(err);

      try {
        var channel = result.rss.channel[0];
        var title = channel && channel.title && channel.title[0];
        var link = channel && channel.link && channel.link[0];
        var exportVersion = channel && channel["wp:wxr_version"] && channel["wp:wxr_version"][0];
        
        console.log(colors.dim("Site URL:"), link);
        console.log(
          colors.dim("Export Version"),
          exportVersion
        );

        // If you want to see other properties available,
        // log this to STDOUT
        // console.log(result.rss.channel);

        if (options.filter) {
          console.log("filter by:", options.filter);
          channel.item = channel.item.filter(
            function (item) {
              return (
                item.title[0]
                  .toLowerCase()
                  .indexOf(options.filter.toLowerCase()) > -1
              );
            }
          );
        }

        var items = channel.item;

        var totalItems = items.length;
      } catch (e) {
        return callback(new Error("Invalid XML"));
      }

      // Final destinations are allocated only after downloads have established
      // whether an entry needs a directory-backed post.txt representation.
      var write = helper.write.createWriter();

      async.eachOfSeries(
        items,
        function (item, index, done) {
          try { require("../../lifecycle").check(); } catch (err) { return done(err); }
          var current = Number(index) + 1;
          var title = item.title[0].trim();

          status("(" + current + "/" + totalItems + ") Processing " + title);
          console.log(colors.dim(current + "/" + totalItems), title);
          injectAttachedThumbnail(item, channel.item);
          Item(item, outputDirectory, write, done);
        },
        callback
      );
    });
  });
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
