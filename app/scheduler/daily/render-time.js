const {
  redisKey,
  encodeEntry,
  decodeEntry,
  DAILY_HISTORY_KEY,
} = require("blog/render/renderTimeMetric");

// Mirrors the three deploy containers in scripts/deploy (blue/green/yellow).
// A container that never served traffic in the last 24h simply has no
// list in Redis, which is fine - lRange on a missing key returns [].
const CONTAINERS = ["blue", "green", "yellow"];

// One entry appended per daily run: today's p50/p95/p99 averages. Used both
// for the email's p95 trailing-average comparison (last HISTORY_DAYS entries)
// and, via scripts/render-time-chart, as an all-time-so-far daily chart.
const HISTORY_KEY = DAILY_HISTORY_KEY;
const HISTORY_DAYS = 7;
// One entry/day is trivially cheap to keep essentially forever - ~100 years
// of daily history is still under a few hundred KB.
const HISTORY_MAX_LENGTH = 100 * 366;

// Only call out the comparison once there's a full trailing window to
// compare against, and only when the move looks like more than day-to-day
// noise. 15% is a starting guess, not a tuned threshold.
const SUBSTANTIAL_CHANGE_FRACTION = 0.15;

async function main(callback) {
  const client = require("models/client");

  try {
    const lists = await Promise.all(
      CONTAINERS.map((container) => client.lRange(redisKey(container), 0, -1))
    );

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const windows = lists
      .flat()
      .map(decodeEntry)
      .filter(({ timestampMs }) => timestampMs >= oneDayAgo);

    // Average of each window's percentile, not a true 24h percentile - see
    // renderTimeMetric.js for why that tradeoff is fine for a daily
    // directional number. Each percentile is averaged independently, skipping
    // NaN, so legacy entries (p95 only) still count towards p95.
    const average = (key) => {
      const values = windows.map((window) => window[key]).filter((n) => !isNaN(n));
      if (values.length === 0) return NaN;
      return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
    };

    const p50Ms = average("p50Ms");
    const p95Ms = average("p95Ms");
    const p99Ms = average("p99Ms");

    if (isNaN(p95Ms)) {
      return callback(null, { render_time: "no data" });
    }

    const priorDays = (await client.lRange(HISTORY_KEY, -HISTORY_DAYS, -1))
      .map(decodeEntry)
      .map(({ p95Ms }) => p95Ms)
      .filter((n) => !isNaN(n));

    const format = (ms) => (isNaN(ms) ? "n/a" : `${ms}ms`);

    let p95Message = format(p95Ms);

    if (priorDays.length >= HISTORY_DAYS) {
      const trailingAverage =
        priorDays.reduce((sum, n) => sum + n, 0) / priorDays.length;
      const diff = p95Ms - trailingAverage;

      if (Math.abs(diff) / trailingAverage >= SUBSTANTIAL_CHANGE_FRACTION) {
        const direction = diff > 0 ? "slower" : "faster";
        p95Message += ` (${Math.round(Math.abs(diff))}ms ${direction} than ${HISTORY_DAYS} day average)`;
      }
    }

    const message = `p50 ${format(p50Ms)}, p95 ${p95Message}, p99 ${format(p99Ms)}`;

    const multi = client.multi();
    multi.rPush(HISTORY_KEY, encodeEntry(Date.now(), { p50Ms, p95Ms, p99Ms }));
    multi.lTrim(HISTORY_KEY, -HISTORY_MAX_LENGTH, -1);
    await multi.exec();

    callback(null, { render_time: message });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;

if (require.main === module) require("./cli")(main);
