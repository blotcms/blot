const { resave: resaveEntries } = require("models/entries");
const updateBlog = require("dashboard/util/update-blog");

var permalink = require("build/prepare/permalink");

var moment = require("moment");

var FORMATS = [
  ["Title", "{{slug}}"],
  ["Date and title", "{{YYYY}}/{{MM}}/{{D}}/{{slug}}"],
  ["Custom format", ""],
];

var SAMPLE = function () {
  return {
    slug: "title-of-post",
    id: 342,
    name: "file-name-of-post.txt",
    path: "/posts/file-name-of-post.txt",
    metadata: {},
  };
};

// The formats to choose from, each with an example, for the Posts tab
function loadFormats(req, res, next) {
  var sample, formats;

  req.trace("Permalink formats: creating sample post");

  sample = new SAMPLE();
  sample.dateStamp = moment.utc();

  formats = FORMATS.slice();

  req.trace("Permalink formats: creating list");

  formats = formats.map(function (arr) {
    var checked = "";
    var example;

    if (req.blog.permalink.isCustom && arr[0] === "Custom format") {
      checked = "checked";
    } else if (
      !req.blog.permalink.isCustom &&
      arr[1] === req.blog.permalink.format
    ) {
      checked = "checked";
    }

    req.trace("Permalink formats: Rendering", arr[1]);
    example = permalink(req.blog.timeZone, arr[1], sample);
    req.trace("Permalink formats: Rendered", arr[1]);

    return {
      name: arr[0],
      value: arr[1],
      checked: checked,
      custom: arr[0] === "Custom format" ? "custom" : "",
      // The custom field and its buttons show only while Custom is chosen
      // (js/site-settings-links.js toggles them after that)
      customStyle: checked ? "" : "display:none",
      example: example,
    };
  });

  formats[formats.length - 1].last = true;
  res.locals.permalinkFormats = formats;

  req.trace("Permalink formats: finished generating list");
  next();
}

// Saves the chosen format, then shows it on the Posts tab again
async function save(req, res) {
  const back = res.locals.base + "/settings/posts";
  const format = req.body.format || "";
  const custom = req.body.custom || "";
  const isCustom = !format && !!custom;

  try {
    const changes = await updateBlog(req.blog.id, {
      permalink: {
        format,
        custom,
        isCustom,
      },
    });

    if (changes && changes.includes("permalink")) {
      await resaveEntries(req.blog.id, () => {});
    }

    res.message(back, "Saved changes to link format");
  } catch (e) {
    res.message(back, e);
  }
}

module.exports = { loadFormats, save };
