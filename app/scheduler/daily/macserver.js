// The iCloud macserver's line of the daily email, in the style of the Server
// line (daily/redis-server.js):
//
//   macserver: root disk 24% (stable, 151 GB free), iCloud 5 GB free, 139 sites
//   macserver process: CPU 152% (160% over 7d), memory 280 MB; host load 4.8 on 4 cores, memory 59% free
//
// It reads the macserver's /stats, as clients/icloud/util/monitorMacServerStats.js
// does every minute. The disk trend comes from the last week of daily readings
// (daily/trend.js), stored at HISTORY_KEY, and projects to a full disk. A disk
// or iCloud figure under its warning threshold (config.icloud) is bold, as is
// a macserver that can't be reached. This never fails the rest of the email.
const config = require("config");
const trend = require("./trend");

// JSON [{ time, used }] of the daily runs, used being the root disk's bytes
const HISTORY_KEY = "blot:icloud:macserver:daily-disk-history";

const { size } = trend;
const percent = (fraction) => Math.round(fraction * 100) + "%";
const bold = (text, flag) => (flag ? `**${text}**` : text);

function diskPart(stats, { history, now }) {
  const free = stats.disk_bytes_available;
  const total = stats.disk_bytes_total;
  const low = free < config.icloud.diskSpaceWarning;

  // A macserver from before /stats reported the disk's size
  if (!(total > 0)) return bold(`root disk ${size(free)} free`, low);

  const used = total - free;
  const text = trend.status({
    percent: percent(used / total),
    free,
    trend: trend.trend({ history, now, used, limit: total, action: "full" }),
  });

  return bold("root disk " + text, low);
}

function icloudPart(stats) {
  const free = stats.icloud_bytes_available;

  // null when the macserver's own quota lookup failed
  if (!(free > 0)) return "iCloud quota unknown";
  return bold(
    `iCloud ${size(free)} free`,
    free < config.icloud.iCloudSpaceWarning
  );
}

// The line for a /stats reply
function line(stats, { history = [], now = Date.now() } = {}) {
  const parts = [diskPart(stats, { history, now }), icloudPart(stats)];

  if (stats.blogs_connected >= 0)
    parts.push(`${stats.blogs_connected.toLocaleString("en-US")} sites`);

  return "macserver: " + parts.join(", ");
}

// The CPU and memory line, or null from a macserver that doesn't report them.
// CPU is a percentage of one core: 200% is two cores flat out.
function processLine(stats) {
  if (!(stats.cpu_percent >= 0) || !(stats.memory_rss_bytes > 0)) return null;

  const since = stats.uptime_seconds
    ? ` over ${trend.compact(stats.uptime_seconds * 1000)}`
    : "";
  const cpu = `CPU ${stats.cpu_percent}% (${stats.cpu_percent_average}%${since})`;
  const own = `${cpu}, memory ${size(stats.memory_rss_bytes)}`;

  const host = [];
  if (stats.load_average >= 0)
    host.push(
      `load ${stats.load_average.toFixed(1)}` +
        (stats.cpu_count ? ` on ${stats.cpu_count} cores` : "")
    );
  if (stats.host_memory_total_bytes > 0)
    host.push(
      `memory ${percent(stats.host_memory_free_bytes / stats.host_memory_total_bytes)} free`
    );

  return (
    "macserver process: " +
    own +
    (host.length ? "; host " + host.join(", ") : "")
  );
}

// The view's lines for a /stats reply
function lines(stats, options) {
  const view = { macserver: line(stats, options) };
  const second = processLine(stats);
  if (second) view.macserver_process = second;
  return view;
}

async function fetchStats() {
  const fetch = require("clients/icloud/util/rateLimitedFetchWithRetriesAndTimeout");
  const body = await fetch(config.icloud.server_address + "/stats", {
    readBody: true,
    headers: { Authorization: config.icloud.secret },
  });
  return JSON.parse(body.toString());
}

async function main(deps = {}) {
  // Hosts without a macserver (development) leave the line out
  if (!deps.fetchStats && !config.icloud.server_address) return {};

  let stats;

  try {
    stats = await (deps.fetchStats || fetchStats)();
    if (!stats || !(stats.disk_bytes_available > 0))
      throw new Error("no disk space in its stats");
  } catch (err) {
    const reason = String((err && err.message) || err)
      .replace(/[*`<>[\]]/g, "")
      .slice(0, 80);
    console.log(
      "Daily update: could not read the macserver stats:",
      err && err.message
    );
    return { macserver: `macserver: **unreachable** (${reason})` };
  }

  try {
    const now = deps.now || Date.now();
    const client = deps.client || require("models/client");
    const history = trend.parse(await client.sendCommand(["GET", HISTORY_KEY]));
    const view = lines(stats, { history, now });

    if (stats.disk_bytes_total > 0)
      await trend.save(client, HISTORY_KEY, history, {
        time: now,
        used: stats.disk_bytes_total - stats.disk_bytes_available,
      });

    return view;
  } catch (err) {
    // Without Redis there is no trend, but the figures still go out
    console.log(
      "Daily update: could not read the macserver disk history:",
      err && err.message
    );
    return lines(stats);
  }
}

module.exports = main;
module.exports.line = line;
module.exports.processLine = processLine;
module.exports.HISTORY_KEY = HISTORY_KEY;

if (require.main === module) require("./cli")(main);
