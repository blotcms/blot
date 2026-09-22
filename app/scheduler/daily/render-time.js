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

// One entry appended per daily run: today's p95 average. Used both for the
// email's trailing-average comparison (last HISTORY_DAYS entries) and, via
// scripts/render-time-chart, as an all-time-so-far daily chart.
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
    const windowP95s = lists
      .flat()
      .map(decodeEntry)
      .filter(({ timestampMs, p95Ms }) => timestampMs >= oneDayAgo && !isNaN(p95Ms))
      .map(({ p95Ms }) => p95Ms);

    if (windowP95s.length === 0) {
      return callback(null, { p95_render_time: "no data" });
    }

    // Average of each window's p95, not a true 24h percentile - see
    // renderTimeMetric.js for why that tradeoff is fine for a daily
    // directional number.
    const average = Math.round(
      windowP95s.reduce((sum, n) => sum + n, 0) / windowP95s.length
    );

    const priorDays = (await client.lRange(HISTORY_KEY, -HISTORY_DAYS, -1))
      .map(decodeEntry)
      .map(({ p95Ms }) => p95Ms)
      .filter((n) => !isNaN(n));

    let message = `${average}ms`;

    if (priorDays.length >= HISTORY_DAYS) {
      const trailingAverage =
        priorDays.reduce((sum, n) => sum + n, 0) / priorDays.length;
      const diff = average - trailingAverage;

      if (Math.abs(diff) / trailingAverage >= SUBSTANTIAL_CHANGE_FRACTION) {
        const direction = diff > 0 ? "slower" : "faster";
        message += ` (${Math.round(Math.abs(diff))}ms ${direction} than ${HISTORY_DAYS} day average)`;
      }
    }

    const multi = client.multi();
    multi.rPush(HISTORY_KEY, encodeEntry(Date.now(), average));
    multi.lTrim(HISTORY_KEY, -HISTORY_MAX_LENGTH, -1);
    await multi.exec();

    callback(null, { p95_render_time: message });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;

if (require.main === module) require("./cli")(main);
