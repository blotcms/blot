var debug = require("debug")("blot:build:prepare");
var _ = require("lodash");
var falsy = require("helper/falsy");
var cheerio = require("cheerio");

var decode = require("he").decode;

var normalize = require("helper/urlNormalizer");
var pathNormalizer = require("helper/pathNormalizer");
var type = require("helper/type");

var makeSlug = require("helper/makeSlug");
var metadataCaseInsensitive = require("helper/metadataCaseInsensitive");
var ensure = require("helper/ensure");
var Model = require("models/entry").model;

var internalLinks = require("./internalLinks");
var isHidden = require("./isHidden");
var Summary = require("./summary");
var Teaser = require("./teaser");
var Title = require("./title");
var Tags = require("./tags");

var overwrite = [
  "summary",
  "title",
  "titleTag",
  "body",
  "slug",
  "summary",
  "teaser",
  "teaserBody"
];

function canOverwrite (key) {
  return overwrite.indexOf(key) > -1;
}

// id: 'number', // this is handled by save
// created: 'number', // this is handled by save
// url: 'string', // this is handled by set
// scheduled: scheduled, // this is handled by set

function Prepare (entry, options = {}) {
  ensure(entry, "object")
    .and(entry.path, "string")
    .and(entry.size, "number")
    .and(entry.html, "string")
    .and(entry.updated, "number")
    .and(entry.draft, "boolean")
    .and(entry.metadata, "object");

  const metadataByLowercaseKey = metadataCaseInsensitive(entry.metadata);

  function metadataValue (key) {
    if (entry.metadata[key] !== undefined) return entry.metadata[key];
    return metadataByLowercaseKey[key.toLowerCase()];
  }

  // The best areas of for speed improvements lie
  // in the next four blocks!

  debug(entry.path, "Generating cheerio");
  var $ = cheerio.load(
    entry.html,
    {
      decodeEntities: false,
      withDomLvl1: false // this may cause issues?
    },
    false
  );
  debug(entry.path, "Generated  cheerio");

  // store titleTag, teaser, remainder;

  // var body = teaser + remainder;
  // var html = titleTag + body;

  // We sometimes fall back to generating a title from the path to the
  // file. We need to know the full path to determine if part of the
  // file's name, from which the title may be generated, includes some
  // part of the date, e.g. /2018/10-10 Hello.jpg. We want to make sure
  // the title is 'Hello' and not '10-10 Hello'. But we can't just use
  // the plain path because some clients, like Dropbox, send the case
  // sensitive name with the update. So we form a temporary variable,
  // pathWithCaseSensitiveName to use to generate a title...
  var pathWithCaseSensitiveName = "";

  if (entry.path && entry.name) {
    pathWithCaseSensitiveName =
      require("path").dirname(entry.path) + "/" + entry.name;
  }

  debug(entry.path, "Generating title from", pathWithCaseSensitiveName);
  var parsedTitle = Title($, pathWithCaseSensitiveName, {
    titlecase: options.titlecase
  });
  entry.title = parsedTitle.title;
  entry.titleTag = parsedTitle.tag;
  entry.body = parsedTitle.body;
  debug(entry.path, "Generated  title", entry.title);

  debug(entry.path, "Generating summary");
  // We pass in the metadata title in case it exists to prevent
  // a bug which surfaces when the file contains title metadata
  var title = entry.title;
  const metadataTitle = metadataValue("title");
  if (type(metadataTitle, Model.title)) title = metadataTitle;
  // The summary is plain text, so strip the teaser marker from the parsed
  // HTML first, while we still know which text is inside code blocks.
  var htmlWithoutBreakPoint = Teaser.stripBreakPoint(entry.html);
  var $summary =
    htmlWithoutBreakPoint === entry.html
      ? $
      : cheerio.load(
          htmlWithoutBreakPoint,
          { decodeEntities: false, withDomLvl1: false },
          false
        );
  entry.summary = Summary($summary, title || "");
  debug(entry.path, "Generated  summary");

  debug(entry.path, "Generating internal links");
  entry.internalLinks = internalLinks($summary, options.blogID);
  debug(entry.path, "Generated internal links");

  debug(entry.path, "Generating teasers");
  entry.teaser = Teaser(entry.html) || entry.html;
  entry.teaserBody = Teaser(entry.body) || entry.body;
  entry.more = entry.teaser !== entry.html;
  entry.html = htmlWithoutBreakPoint;
  entry.body = Teaser.stripBreakPoint(entry.body);
  debug(entry.path, "Generated  teasers");

  debug(entry.path, "Generating makeSlug");
  entry.slug = makeSlug(metadataValue("title") || entry.title);
  debug(entry.path, "Generated  makeSlug");

  debug(entry.path, "Generating tags");
  var tags = [];

  const metadataTags = metadataValue("tags");

  if (metadataTags) {
    if (Array.isArray(metadataTags)) {
      tags = metadataTags.map(tag => String(tag));
    } else if (typeof metadataTags === "string") {
      tags = metadataTags.split(",");
    }
  }

  tags = Tags(entry.path, tags);
  tags = _(tags)
    .map(function (tag) {
      return tag.trim();
    })
    .compact(tags)
    .uniq()
    .value();

  entry.tags = tags;
  debug(entry.path, "Generated  tags");

  debug(entry.path, "Generating booleans");

  entry.deleted = false;

  // An entry is a draft if it has draft: yes in its metadata, or if it is inside
  // a folder called drafts.
  if (truthy(metadataValue("draft"))) entry.draft = true;

  // An entry becomes a page if it:
  // begins with an underscore
  // or is inside a folder called 'pages'
  // or has 'Page: yes' in its metadata
  // or has 'Menu: X' in its metadata, page is implied
  entry.page =
    isHidden(entry.path) ||
    isPage(entry.path) ||
    truthy(metadataValue("page")) ||
    metadataValue("menu") !== undefined;

  // An entry is only added to the menu:
  // if it is a page
  // and it does not start with an underscore
  // and it does not have defined, falsy (e.g. 'no') menu metadata
  entry.menu =
    entry.page &&
    !isHidden(entry.path) &&
    (metadataValue("menu") === undefined || truthy(metadataValue("menu")));

  debug(entry.path, "Generated  booleans");

  debug(entry.path, "Generating permalink");
  // Add the permalink automatically if the metadata
  // declared a page with no permalink set. We can't
  // do this earlier, since we don't know the slug then
  let permalinkCandidates = [
    metadataValue("permalink"),
    metadataValue("link"),
    metadataValue("url")
  ];

  permalinkCandidates = permalinkCandidates
    .filter(
      candidate =>
        candidate &&
        type(candidate, "string") &&
        candidate.indexOf("://") === -1
    )
    .map(normalize)
    .filter(candidate => candidate !== "");

  entry.permalink = permalinkCandidates.shift() || "";
  debug(entry.path, "Generated  permalink");

  debug(entry.path, "Generating meta-overwrite");

  const modelKeyByLower = Object.keys(Model).reduce((acc, modelKey) => {
    acc[modelKey.toLowerCase()] = modelKey;
    return acc;
  }, {});

  for (var key in entry.metadata) {
    const canonical = modelKeyByLower[key.toLowerCase()];

    if (canOverwrite(canonical) && type(entry.metadata[key], Model[canonical]))
      entry[canonical] = entry.metadata[key];
  }

  debug(entry.path, "Generated  meta-overwrite");

  debug(entry.path, "Generating decoding");
  entry.title = decode(entry.title);
  entry.summary = decode(entry.summary);
  for (var tag in entry.tags) entry.tags[tag] = decode(entry.tags[tag]);
  debug(entry.path, "Generated  decoding");

  return entry;
}

function truthy (str) {
  return !falsy(str);
}

function isPage (path) {
  return (
    pathNormalizer(path).toLowerCase().startsWith("/page/") ||
    pathNormalizer(path).toLowerCase().startsWith("/pages/")
  );
}

module.exports = Prepare;
