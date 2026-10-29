// The "27% (stable, 19 GB free)" format the daily email uses for Redis memory,
// the Redis host's disk and the data disk, and the history behind the trend.
//
// Each figure keeps the last few daily readings of how much it uses, as JSON
// [{ time, used, scope? }] in Redis with no TTL. The trend is the growth from
// the oldest reading within a week to the current one, scaled to a day, so one
// odd day (a big import, a prune) doesn't swing it. It is "stable" when the
// figure isn't growing or would take more than a year to reach its limit.
// Readings in bytes survive a resize of the volume, which percentages don't.
// A different `scope` (the Redis host's name) starts the history afresh.
const prettySize = require("helper/prettySize");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A reading closer than this to the last one is no basis for a trend (and is
// not added: a manual re-run leaves the real history alone).
const MIN_GAP_MS = HOUR;
// The trend looks back this far, and no more readings than this are kept.
const WINDOW_MS = 7 * DAY + HOUR;
const MAX_POINTS = 8;
// Growth slower than this, or none, is "stable".
const STABLE_DAYS = 365;

// prettySize takes kilobytes, 1000 to the unit, and divides by 1024.
const size = (bytes) => prettySize(bytes / 1000, 1);

function parse(value) {
  try {
    const points = JSON.parse(value);

    return Array.isArray(points) ? points.filter((point) => point && point.time > 0 && point.used >= 0) : [];
  } catch (e) {
    return [];
  }
}

// The history with this reading added, or as it was if the last reading is
// too recent. `used` is in bytes.
function record(history, { time, used, scope }) {
  const last = history[history.length - 1];

  if (last && time - last.time < MIN_GAP_MS) return history;

  const point = scope === undefined ? { time, used } : { time, used, scope };
  return history.concat(point).slice(-MAX_POINTS);
}

// "stable", "resize in ~47 days", the `over` text (default "resize now") once
// `used` has reached `limit`, or "" without a reading to compare with.
// `action` is the verb for what to do about it. `used` and `limit` are bytes.
function trend({ history, now, used, limit, action = "resize", scope, over }) {
  if (used >= limit) return over || action + " now";

  const oldest = history.find(
    (point) => point.scope === scope && now - point.time >= MIN_GAP_MS && now - point.time <= WINDOW_MS
  );

  if (!oldest) return "";

  const perDay = ((used - oldest.used) * DAY) / (now - oldest.time);
  const days = (limit - used) / perDay;

  if (!(perDay > 0) || days > STABLE_DAYS) return "stable";
  return `${action} in ~${Math.max(1, Math.round(days))} days`;
}

// "19% (stable, 22 GB free)", or "19% (22 GB free)" with no trend yet.
// `percent` is the text, "19%", and `free` is in bytes (none, if over).
function status({ percent, free, trend }) {
  return `${percent} (${[trend, size(Math.max(0, free)) + " free"].filter(Boolean).join(", ")})`;
}

// Stores the history with today's reading. A failure to store it only costs
// tomorrow's trend.
async function save(client, key, history, reading) {
  const updated = record(history, reading);
  if (updated === history) return;

  try {
    await client.sendCommand(["SET", key, JSON.stringify(updated)]);
  } catch (err) {
    console.log("Daily update: could not store the history for " + key + ":", err.message);
  }
}

module.exports = { parse, record, trend, status, save, size, MIN_GAP_MS, MAX_POINTS };
