const { redisKey, decodeEntry } = require("blog/render/renderTimeMetric");

// Mirrors the three deploy containers in scripts/deploy (blue/green/yellow).
// A container that never served traffic in the last 24h simply has no
// list in Redis, which is fine - lRange on a missing key returns [].
const CONTAINERS = ["blue", "green", "yellow"];

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

    callback(null, { p95_render_time: `${average}ms` });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;

if (require.main === module) require("./cli")(main);
