var makeSlug = require("helper/makeSlug");
var removeDiacritics = require("helper/removeDiacritics");
var mustache = require("mustache");
var moment = require("moment");
var debug = require("debug")("blot:prepare:permalink");

require("moment-timezone");

var DEFAULT = "{{slug}}";

// this needs to be pulled directly from the moment library
// i copied them from the docs.
var MOMENT_TOKENS = [
  "M",
  "Mo",
  "MM",
  "MMM",
  "MMMM",
  "Q",
  "Qo",
  "D",
  "Do",
  "DD",
  "DDD",
  "DDDo",
  "DDDD",
  "d",
  "do",
  "dd",
  "ddd",
  "dddd",
  "e",
  "E",
  "w",
  "wo",
  "ww",
  "W",
  "Wo",
  "WW",
  "YY",
  "YYYY",
  "Y",
  "gg",
  "gggg",
  "GG",
  "GGGG",
  "A",
  "a",
  "H",
  "HH",
  "h",
  "hh",
  "k",
  "kk",
  "m",
  "mm",
  "s",
  "ss",
  "S",
  "SS",
  "SSS",
  "SSSS",
  "SSSSS",
  "SSSSSS",
  "SSSSSSS",
  "SSSSSSSS",
  "SSSSSSSSS",
  "z",
  "zz",
  "Z",
  "ZZ",
  "X",
  "x"
];
var normalize = require("helper/urlNormalizer");
var allow = [
  "slug",
  "name",
  "size",
  "path",
  "more",
  "menu",
  "page",
  "dateStamp",
  "created",
  "updated",
  "metadata"
];

module.exports = function (timeZone, format, entry) {
  // Add the permalink automatically if the metadata
  // declared a page with no permalink set. We can't
  // do this earlier, since we don't know the slug then
  var permalink = "";
  var view = {};

  format = format || DEFAULT;

  try {
    // this is so inefficient
    MOMENT_TOKENS.forEach(function (token) {
      view[token] = moment
        .utc(entry.dateStamp || entry.updated)
        .tz(timeZone)
        .format(token);
    });

    for (var i in entry) if (allow.indexOf(i) > -1) view[i] = entry[i];

    // A folder post's path/name is synthesized from its "+" folder (e.g. the
    // aggregate for "/release.v1+" is stored at "/release.v1") and has no
    // real file extension, even when it contains a dot. Don't let a dot
    // anywhere in that path be mistaken for one.
    var isFolderPost =
      typeof entry.html === "string" &&
      entry.html.indexOf('class="multi-file-post"') !== -1;

    // this needs a better name but make sure to update any
    // existing custom formats for folks...
    var pathDot = isFolderPost ? -1 : entry.path.lastIndexOf(".");
    view["path-without-extension"] =
      pathDot === -1 ? entry.path : entry.path.slice(0, pathDot);

    // stem should be path without extension
    view.stem = makeSlug(view["path-without-extension"]);

    // this needs a better name but make sure to update any
    // existing custom formats for folks...
    var nameDot = isFolderPost ? -1 : view.name.lastIndexOf(".");
    view["name-without-extension"] =
      nameDot === -1 ? view.name : view.name.slice(0, nameDot);

    // this needs a better name but make sure to update any
    // existing custom formats for folks...
    view["slug-without-diacritics"] = removeDiacritics(view.slug);

    // we don't want mustache to escape anything...
    format = format.split("{{").join("{{{");
    format = format.split("}}").join("}}}");
    debug("format", format);
    debug("view", view);
    permalink = mustache.render(format || DEFAULT, view);
    debug("permalink", permalink);
  } catch (e) {
    console.log(e);
    permalink = "";
  }

  return normalize(permalink);
};
