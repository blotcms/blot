// The iCloud macserver's line of the daily email, in the style of the Server
// line (daily/redis-server.js):
//
//   Mac server: root disk 25% (stable, 151 GB free), iCloud 5 GB free, memory 61% (6 GB free), CPU 195% (192% over 26h), 139 sites
//
// It reads the macserver's /stats, as clients/icloud/util/monitorMacServerStats.js
// does every minute. The disk trend comes from the last week of daily readings
// (daily/trend.js), stored at HISTORY_KEY, and projects to the disk warning
// (config.icloud.diskSpaceWarning), where the alert emails start. A disk or
// iCloud figure under its warning threshold is bold, as are host memory under
// HOST_RAM_WARNING and a macserver that can't be reached. This never fails the
// rest of the email.
const config = require("config");
const trend = require("./trend");

// JSON [{ time, used }] of the daily runs, used being the root disk's bytes
const HISTORY_KEY = "blot:icloud:macserver:daily-disk-history";

// As the Server line's HOST_RAM_WARNING
const HOST_RAM_WARNING = 0.15;

const PREFIX = "Mac server: ";

const { size } = trend;
const percent = (fraction) => Math.round(fraction * 100) + "%";
const bold = (text, flag) => (flag ? `**${text}**` : text);

function diskPart(stats, { history, now }) {
  const free = stats.disk_bytes_available;
  const total = stats.disk_bytes_total;
  const warning = config.icloud.diskSpaceWarning;
  const low = free < warning;

  // A macserver from before /stats reported the disk's size
  if (!(total > 0)) return bold(`root disk ${size(free)} free`, low);

  const used = total - free;
  const text = trend.status({
    percent: percent(used / total),
    free,
    trend: trend.trend({ history, now, used, limit: total - warning }),
  });

  return bold("root disk " + text, low);
}

function icloudPart(stats) {
  const free = stats.icloud_bytes_available;

  // null when the macserver's own quota lookup failed; 0 is a real reading
  if (typeof free !== "number" || !(free >= 0)) return "iCloud quota unknown";
  return bold(
    `iCloud ${size(free)} free`,
    free < config.icloud.iCloudSpaceWarning
  );
}

// Memory in use on the Mac, from the memory macOS could give a process without
// swapping (host_memory_available_bytes). A macserver that only reports the
// kernel's free pages (host_memory_free_bytes, close to none on macOS, which
// keeps spare memory as cache) leaves it out, since that reads as full.
function memoryPart(stats) {
  const available = stats.host_memory_available_bytes;
  const total = stats.host_memory_total_bytes;
  if (!(total > 0) || !(available >= 0)) return null;

  const fraction = Math.min(1, available / total);
  return bold(
    `memory ${percent(1 - fraction)} (${size(available)} free)`,
    fraction < HOST_RAM_WARNING
  );
}

// The macserver process's CPU, as a percentage of one core: 200% is two cores
// flat out. Null from a macserver that doesn't report it.
function cpuPart(stats) {
  if (!(stats.cpu_percent >= 0)) return null;
  if (!(stats.cpu_percent_average >= 0)) return `CPU ${stats.cpu_percent}%`;

  const since = stats.uptime_seconds
    ? ` over ${trend.compact(stats.uptime_seconds * 1000)}`
    : "";
  return `CPU ${stats.cpu_percent}% (${stats.cpu_percent_average}%${since})`;
}

// The line for a /stats reply
function line(stats, { history = [], now = Date.now() } = {}) {
  const parts = [
    diskPart(stats, { history, now }),
    icloudPart(stats),
    memoryPart(stats),
    cpuPart(stats),
  ];

  if (stats.blogs_connected >= 0)
    parts.push(`${stats.blogs_connected.toLocaleString("en-US")} sites`);

  return PREFIX + parts.filter(Boolean).join(", ");
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
    if (!stats || !(stats.disk_bytes_available >= 0))
      throw new Error("no disk space in its stats");
  } catch (err) {
    const reason = String((err && err.message) || err)
      .replace(/[*`<>[\]]/g, "")
      .slice(0, 80);
    console.log(
      "Daily update: could not read the macserver stats:",
      err && err.message
    );
    return { macserver: `${PREFIX}**unreachable** (${reason})` };
  }

  try {
    const now = deps.now || Date.now();
    const client = deps.client || require("models/client");
    const history = trend.parse(await client.sendCommand(["GET", HISTORY_KEY]));
    const view = { macserver: line(stats, { history, now }) };

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
    return { macserver: line(stats) };
  }
}

module.exports = main;
module.exports.line = line;
module.exports.HISTORY_KEY = HISTORY_KEY;

if (require.main === module) require("./cli")(main);
