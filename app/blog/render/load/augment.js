const normalize = require("models/tags").normalize;
const type = require("helper/type");
const { getEntryByUrl } = require("../../lib/models");
const moment = require("moment");
const debug = require("debug")("blog:render:augment");
require("moment-timezone");

module.exports = async function augment(req, res, entry) {
  // augment() rewrites several entry fields in place (tags, backlinks, ...)
  // in ways that aren't safe to re-run: a second pass sees the already
  // -converted values and discards them as invalid. Callers are expected to
  // invoke this once per Entry object (see eachEntry.js's identity dedup),
  // but guard here too so a future caller reaching the same object twice
  // can't silently corrupt it.
  if (entry.__augmented) return;
  entry.__augmented = true;

  const blog = req.blog;

  entry.metadata = createRenderMetadata(entry.metadata);

  // Can be either inherited from the properties of the blog
  // or from the template, or from the view
  const hideDate = res.locals.hide_dates || false;
  const dateDisplay = res.locals.date_display || "MMMM D, Y";

  entry.formatDate = FormatDate(entry.dateStamp, req.blog.timeZone);
  entry.formatUpdated = FormatDate(entry.updated, req.blog.timeZone);
  entry.formatCreated = FormatDate(entry.created, req.blog.timeZone);

  entry.absoluteURL =
    req.blog.locals.blogURL +
    entry.url.split("/").map(encodeURIComponent).join("/");

  // if the entry exif object is empty, delete it
  if (
    entry.exif &&
    type(entry.exif, "object") &&
    Object.keys(entry.exif).length === 0
  ) {
    delete entry.exif;
  }

  // if the entry thumbnail object is empty, delete it
  if (
    entry.thumbnail &&
    type(entry.thumbnail, "object") &&
    Object.keys(entry.thumbnail).length === 0
  ) {
    delete entry.thumbnail;
  }

  const tags = [];
  const tagged = {};
  const totalTags = entry.tags.length;

  for (let i = 0; i < totalTags; i++) {
    const tag = entry.tags[i];

    // Tags should always be strings at this point; skip anything else
    // rather than crash on malformed data.
    if (!type(tag, "string")) {
      console.log(
        "Error BAD TAG:",
        req.blog.id,
        req.originalHost,
        req.url,
        "has format date?",
        type(entry.formatDate, "function")
      );
      console.log(tag);
      continue;
    }

    if (!tag) continue;

    const slug = normalize(tag);
    const lower = tag.toLowerCase();

    tagged[tag] = tagged[lower] = tagged[slug] = true;

    tags.push({
      name: tag,
      tag: tag,
      slug: encodeURIComponent(slug),
      first: i === 0,
      last: i === totalTags - 1,
    });
  }

  for (const k in entry.thumbnail) {
    entry.thumbnail[k].ratio =
      (entry.thumbnail[k].height / entry.thumbnail[k].width) * 100 + "%";
  }

  entry.tags = tags;
  entry.tagged = tagged;

  // We don't want to compute the entry's date
  // string if the user explicitly told use to
  // hide the dates. We also want to hide the
  // dates for items in the menu, and items which
  // are pages. Otherwise its weird.
  if (!hideDate && !entry.menu && !entry.page) {
    entry.date = moment
      .utc(entry.dateStamp)
      .tz(blog.timeZone)
      .format(dateDisplay);
  } else {
    delete entry.date;
  }

  entry.backlinks = entry.backlinks || [];

  debug(entry.path, "fetching backlinks", entry.backlinks);

  const resolved = await Promise.all(
    entry.backlinks.map(async (linkUrl) => {
      debug("Looking up backlink for linkUrl", linkUrl);
      if (typeof linkUrl !== "string") {
        return null;
      }
      const linked = await getEntryByUrl(req.blog.id, linkUrl);
      if (linked) {
        debug("Found", linked.path, "for", linkUrl);
      } else {
        debug("No entry found for", linkUrl);
      }
      return linked;
    })
  );

  debug(entry.path, "fetched backlinks", resolved);
  entry.backlinks = resolved.filter(
    (backlinkedEntry) =>
      !!backlinkedEntry &&
      // we don't want to show unpublished entries
      !backlinkedEntry.scheduled &&
      // we don't want to show the same entry
      backlinkedEntry.path !== entry.path
  );

  // Deduplicate by path without lodash
  const seen = new Set();
  entry.backlinks = entry.backlinks.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });

  debug(entry.path, "final backlinks", entry.backlinks);
};

function createRenderMetadata(sourceMetadata) {
  if (!sourceMetadata || !type(sourceMetadata, "object")) {
    return sourceMetadata;
  }

  const renderMetadata = Object.assign({}, sourceMetadata);
  const keys = Object.keys(sourceMetadata);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const lowerKey = key.toLowerCase();

    if (
      lowerKey === key ||
      Object.prototype.hasOwnProperty.call(renderMetadata, lowerKey)
    ) {
      continue;
    }

    renderMetadata[lowerKey] = sourceMetadata[key];
  }

  return renderMetadata;
}

function FormatDate(dateStamp, zone) {
  return function () {
    return function (text, render) {
      try {
        text = render(text).trim();
        text = moment.utc(dateStamp).tz(zone).format(text);
      } catch (e) {
        text = "";
      }

      return render(text);
    };
  };
}
