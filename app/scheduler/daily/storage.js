// The storage bucket's line of the daily email, one line in the style of the
// Redis line (a comma-joined set of parts):
//
//   Storage: 2 TB in 1,234,567 objects (+12 GB this week), offsite copied 9h ago
//
// config/storage-bucket/bin/offsite-sync.sh records each successful daily copy
// of the whole bucket to B2 in STORAGE_OFFSITE_KEY, with the objects and bytes
// B2 then holds, which is the bucket's size. The growth is the change in bytes
// over the last week of daily readings (daily/trend.js), stored at HISTORY_KEY
// and left out with under a day of history. The offsite part is bold when the
// copy is overdue or its record can't be read. Nothing is shown where no copy
// was ever recorded (hosts without the offsite). This never fails the rest of
// the email.
const {
  parseStorageOffsite,
  STORAGE_OFFSITE_KEY,
} = require("../check-redis-host");
const trend = require("./trend");

// JSON [{ time, used }] of the copies, used being the bucket's bytes, no TTL
const HISTORY_KEY = "blot:storage:daily-history";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The offsite copy is daily; allow one missed day.
const OVERDUE_MS = 2 * DAY;
// Growth needs a reading at least this old, and none older than a week.
const MIN_HISTORY_MS = 22 * HOUR;
const MAX_HISTORY_MS = 7 * DAY + HOUR;
// A span shorter than this isn't "this week".
const WEEK_MS = 6 * DAY;

const { size, compact } = trend;

// "+12 GB this week", "-4 GB this week", "+3 GB in 2d", or "" without a day of
// history. Compared with the oldest reading within a week of the copy.
function growth(copy, history) {
  const oldest = history.find(
    (point) =>
      copy.time - point.time >= MIN_HISTORY_MS &&
      copy.time - point.time <= MAX_HISTORY_MS
  );
  if (!oldest) return "";

  const span = copy.time - oldest.time;
  const change = copy.bytes - oldest.used;
  const when = span >= WEEK_MS ? "this week" : "in " + compact(span);

  if (size(Math.abs(change)) === size(0)) return `no change ${when}`;
  return `${change > 0 ? "+" : "-"}${size(Math.abs(change))} ${when}`;
}

function offsitePart(copy, now) {
  const age = now - copy.time;

  return age > OVERDUE_MS
    ? `**last offsite copy ${compact(age)} ago, overdue**`
    : `offsite copied ${compact(age)} ago`;
}

// The line, or null where no copy was ever recorded (`value` is the key's raw
// value, null or undefined if unset).
function line(value, { history = [], now = Date.now() } = {}) {
  if (value === null || value === undefined) return null;

  const copy = parseStorageOffsite(value);
  if (!copy) return "Storage: **offsite copy record unreadable**";

  const change = growth(copy, history);
  const bucket =
    `${size(copy.bytes)} in ${copy.objects.toLocaleString("en-US")} objects` +
    (change ? ` (${change})` : "");

  return "Storage: " + [bucket, offsitePart(copy, now)].join(", ");
}

function main(callback, deps = {}) {
  (async function () {
    const now = deps.now || Date.now();
    const client = deps.client || require("models/client");
    const value = await client.sendCommand(["GET", STORAGE_OFFSITE_KEY]);
    const history = trend.parse(await client.sendCommand(["GET", HISTORY_KEY]));
    const text = line(value, { history, now });

    // A reading is stamped with when its copy finished, so a re-run before the
    // next copy leaves the history alone
    const copy = text && parseStorageOffsite(value);
    if (copy)
      await trend.save(client, HISTORY_KEY, history, {
        time: copy.time,
        used: copy.bytes,
      });

    return text ? { storage: text } : {};
  })().then(
    (result) => callback(null, result),
    (err) => {
      const reason = String((err && err.message) || err)
        .replace(/[*`<>[\]]/g, "")
        .slice(0, 80);
      console.log(
        "Daily update: could not read the storage bucket:",
        err && err.message
      );
      callback(null, { storage: `Storage: unavailable (${reason})` });
    }
  );
}

module.exports = main;
module.exports.line = line;
module.exports.growth = growth;
module.exports.HISTORY_KEY = HISTORY_KEY;

if (require.main === module) require("./cli")(main);
