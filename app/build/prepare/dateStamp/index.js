const debug = require("debug")("blot:build:dateStamp");

const fromPath = require("./fromPath");
const fromMetadata = require("./fromMetadata");
const type = require("helper/type");

const moment = require("moment");
require("moment-timezone");

const metadataCaseInsensitive = require("helper/metadataCaseInsensitive");

module.exports = function (blog, path, metadata, previousCreated) {
  const { id, dateFormat, timeZone } = blog;
  let dateStamp;

  debug("Blog:", id, "dateFormat:", dateFormat, "timeZone", timeZone, path);

  const metadataByLowercaseKey = metadataCaseInsensitive(metadata);
  const metadataDate = metadataByLowercaseKey.date;

  // If the user specified a date
  // field in the entry's metadata,
  // try and parse a timestamp from it.
  if (metadataDate) {
    // Since there is the possibilty of using YAML, the date might not be a string
    let dateMetadataString = String(metadataDate);
    let parsedFromMetadata = fromMetadata(dateMetadataString, dateFormat, timeZone);
    dateStamp = validate(parsedFromMetadata.created);
    if (dateStamp && parsedFromMetadata.adjusted) {
      debug("Blog:", id, "Date from metadata adjusted by timezone in metadata", dateStamp);
      return dateStamp;
    } else if (dateStamp) {
      debug("Blog:", id, "Date from metadata", dateStamp);
      // dateStamp still holds the literal calendar date exactly as
      // written/parsed (interpreted as UTC) - capture it before
      // adjustByBlogTimezone potentially shifts it onto a different
      // UTC-midnight-relative date, so "same day" comparisons below are
      // against the date the user actually intended, not an artifact of
      // the timezone adjustment.
      const intendedDateStamp = dateStamp;
      const adjustedDateStamp = adjustByBlogTimezone(timeZone, dateStamp);
      return useCreatedTimeIfSameDay(
        adjustedDateStamp,
        intendedDateStamp,
        /\d{1,2}:\d{1,2}/.test(dateMetadataString),
        previousCreated,
        timeZone
      );
    }
  }

  // The user didn't specify a valid
  // date in the entry's metadata. Try
  // and extract one from the file's path
  const parsedFromPath = fromPath(path, timeZone);
  dateStamp = validate(parsedFromPath.created);

  if (dateStamp !== undefined) {
    debug("Blog:", id, "Date from path", dateStamp);
    const intendedDateStamp = dateStamp;
    const adjustedDateStamp = adjustByBlogTimezone(timeZone, dateStamp);
    return useCreatedTimeIfSameDay(
      adjustedDateStamp,
      intendedDateStamp,
      !!parsedFromPath.hasTime,
      previousCreated,
      timeZone
    );
  }

  // It is important we return undefined since we fall back
  // to the file's created date if that's the case
  debug("Blog:", id, "No date found in metadata or path");
  return undefined;
};

function validate(stamp) {
  debug("Validating date", stamp);
  if (type(stamp, "number") && !isNaN(stamp) && moment.utc(stamp).isValid())
    return stamp;
  
  return undefined;
}

// A date sourced from metadata (e.g. "Date: 12/12/2025") or a path (e.g.
// "/2025/12/12/post.txt") often carries no time-of-day, so it parses to
// midnight. If the entry already exists and was first created by Blot on
// that same calendar day (in the blog's timezone), reuse its creation
// instant instead - it's a better guess than midnight for "when was this
// written". An explicit time (in the metadata string, or as extra
// hour/minute tokens in the path), or a date that doesn't match the
// entry's creation day (e.g. because the post was backdated, or the date
// was later edited), leaves the parsed timestamp untouched. Removing the
// date metadata entirely skips this function altogether for that branch,
// since dateStamp then falls back to the path or to previousCreated
// directly.
function useCreatedTimeIfSameDay(
  adjustedDateStamp,
  intendedDateStamp,
  hasExplicitTime,
  previousCreated,
  timeZone
) {
  if (hasExplicitTime) return adjustedDateStamp;

  if (typeof previousCreated !== "number" || isNaN(previousCreated))
    return adjustedDateStamp;

  var zone = timeZone && moment.tz.zone(timeZone) ? timeZone : "Etc/UTC";

  // intendedDateStamp is the calendar date exactly as written/parsed,
  // read as literal UTC fields - comparing it in UTC (rather than
  // re-deriving it through the blog's timezone) avoids a mismatch when a
  // timezone's offset changes between UTC midnight and local midnight.
  var intendedDay = moment.utc(intendedDateStamp).format("YYYY-MM-DD");
  var createdDay = moment.tz(previousCreated, zone).format("YYYY-MM-DD");

  if (intendedDay !== createdDay) return adjustedDateStamp;

  // Same calendar day: previousCreated is already a valid instant on
  // that day, so use it directly. Rebuilding a timestamp from wall-clock
  // fields (year/month/day from one moment, hour/minute/second from
  // another) can pick the wrong UTC offset during a DST fall-back
  // transition, when a local wall-clock time occurs twice.
  return previousCreated;
}

function adjustByBlogTimezone(timeZone, stamp) {
  var zone = moment.tz.zone(timeZone);

  if (!zone) {
    debug("Timezone not found", timeZone);
    return stamp;
  }
  
  var offset = zone.utcOffset(stamp);
  debug("Adjusting date by timezone", offset, timeZone);
  return moment.utc(stamp).add(offset, "minutes").valueOf();
}
