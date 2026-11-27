const normalize = require("models/tags").normalize;
const tagSlug = require("../retrieve/helpers/tagSlug");
const type = require("helper/type");
const backlinksFor = require("./backlinks");
const eventDate = require("./eventDate");
const moment = require("moment");
require("moment-timezone");

// backlinks (optional): resolves the entry's backlinks. Share one across a walk
// over many entries (see ./backlinks.js); the default is for this entry alone.
module.exports = async function augment(
  req,
  res,
  entry,
  backlinks = backlinksFor(req)
) {
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

  // An Event line that is a date (./eventDate.js) gets the same formatting
  // helper as the entry's own date, and says whether the event is still to
  // come. A line that isn't a date is left for the template to show as it is.
  const event = eventDate(entry.metadata, req.blog.timeZone);
  if (event) {
    // A repeating event is shown at its next occurrence
    const nextStamp = eventDate.next(event, Date.now(), req.blog.timeZone);
    const stamp = nextStamp !== null ? nextStamp : event.stamp;
    entry.formatEvent = FormatDate(stamp, req.blog.timeZone);
    // A multi-day event's last day, moved along with a repeating one, and
    // the day after it, which calendar feeds use as the (exclusive) end
    const endsDay = eventDate.endsOn(event, stamp, req.blog.timeZone);
    if (endsDay !== null) {
      entry.formatEnds = FormatDate(endsDay, req.blog.timeZone);
      entry.formatEndsAfter = FormatDate(
        moment.tz(endsDay, req.blog.timeZone).add(1, "day").valueOf(),
        req.blog.timeZone
      );
    }
    entry.event = {
      stamp,
      allDay: event.allDay,
      timed: !event.allDay,
      multiDay: !!event.endsDay,
      repeats: event.repeats || false,
      rrule: eventDate.rrule(event, req.blog.timeZone),
      upcoming: nextStamp !== null,
      past: nextStamp === null,
    };
  }

  entry.absoluteURL = absoluteURL(req.blog.locals.blogURL, entry.url);

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
      slug: tagSlug(slug),
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

  entry.backlinks = await backlinks.resolve(entry);
};

// blogURL is per request (protocol + the host it arrived on - see
// blog/middleware/vhosts.js), so shared augmented entries recompute this.
function absoluteURL(blogURL, url) {
  return blogURL + url.split("/").map(encodeURIComponent).join("/");
}

module.exports.absoluteURL = absoluteURL;

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

      // Return the formatted date as-is. Passing it back through render()
      // made Mustache parse and cache every distinct date as a template,
      // filling its process-wide template cache on a long list and evicting
      // the real views and partials, which were then re-parsed every render.
      return text;
    };
  };
}
