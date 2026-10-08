// The "Redis server" lines of the daily email (blotcms/blot#2041): memory,
// disk space, the last backup, and a nudge to resize the host before it fills.
//
// Redis tells us its own memory, but only the Redis host can read its RAM and
// disk: config/redis/bin/tcpmem-log.sh stores those in its 5-minute sample
// (SAMPLE_KEY), and config/redis/bin/backup.sh stores each upload in
// BACKUP_KEY. Missing or stale data is said so in the email; it never fails
// the rest of it.
const prettySize = require("helper/prettySize");
const { parseSample, parseMemory, SAMPLE_KEY } = require("../check-redis-host");

const BACKUP_KEY = "blot:redis-host:backup";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// check-redis-host.js emails at 80%; the daily email points at the README a
// bit earlier, since a bigger host takes a few days to plan.
const MEMORY_WARNING = 0.7;
const RESIZE_URL =
  "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size";

// The host samples every 5 minutes (see check-redis-host.js's STALE_MS).
const SAMPLE_STALE_MS = 20 * MINUTE;
// Backups are hourly (the daily one is a second upload at 03:05).
const BACKUP_OVERDUE_MS = 2 * HOUR;

// prettySize takes kilobytes, 1000 to the unit, and divides by 1024.
const size = (bytes) => prettySize(bytes / 1000, 1);
const percent = (fraction) => Math.round(fraction * 100) + "%";

function ago(ms) {
  if (ms < HOUR) return Math.max(0, Math.round(ms / MINUTE)) + " minutes ago";
  if (ms < 48 * HOUR) return Math.round(ms / HOUR) + " hours ago";
  return Math.round(ms / (24 * HOUR)) + " days ago";
}

// "2026-10-08T03:05:11Z daily daily/2026-10-08-hour-03.rdb 4123456789"
// (backup.sh). Null if it can't be read.
function parseBackup(value) {
  if (!value) return null;

  const [stamp, kind, key, bytes] = String(value).trim().split(/\s+/);
  const time = Date.parse(stamp);

  if (!time || !kind || !key) return null;

  return {
    time,
    kind: kind.replace(/[^\w-]/g, ""),
    key: key.replace(/[^\w./-]/g, ""),
    bytes: Number(bytes) > 0 ? Number(bytes) : null,
  };
}

// Everything the section needs, from Redis. client.sendCommand keeps these off
// the client-side cache: the host writes them from another client.
async function collect({ client = require("models/client"), now = Date.now() } = {}) {
  const [info, sampleValue, backupValue] = await Promise.all([
    client.sendCommand(["INFO", "memory"]),
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", BACKUP_KEY]),
  ]);

  return {
    now,
    memory: parseMemory(info),
    sample: parseSample(sampleValue),
    backup: parseBackup(backupValue),
  };
}

const disk = (label, { used, total }) =>
  `${label} ${size(used)} of ${size(total)} used (${percent(used / total)})`;

// Turns collect()'s data into the lines of the email, as markdown.
function lines({ now, memory, sample, backup }) {
  const result = [];
  const stale = sample && now - sample.time > SAMPLE_STALE_MS;

  // Memory. This is the figure check-redis-host.js alerts on: used_memory
  // less replica output buffers.
  let text = memory.maxmemory
    ? `Memory: ${size(memory.used)} used of ${size(memory.maxmemory)} maxmemory (${percent(memory.used / memory.maxmemory)})`
    : `Memory: ${size(memory.used)} used, no maxmemory set`;
  text += sample && sample.ramTotal ? `, ${size(sample.ramTotal)} RAM on the host` : ", host RAM unknown";
  result.push(text);

  // Disk, from the host's sample.
  if (!sample) {
    result.push("Disk: no sample from the Redis host");
  } else {
    const parts = [];
    if (sample.diskRoot) parts.push(disk("/", sample.diskRoot));
    if (sample.diskBackups) parts.push(disk("/backups", sample.diskBackups));
    else if (sample.diskRoot) parts.push("/backups not mounted");
    text = parts.length ? "Disk: " + parts.join(", ") : "Disk: not reported by the Redis host";
    if (stale) text += ` (sample from ${ago(now - sample.time)}, the Redis host may have stopped reporting)`;
    result.push(text);
  }

  // Backup
  if (!backup) {
    result.push("Last backup: no backup recorded");
  } else {
    const age = now - backup.time;
    text = `Last backup: ${ago(age)}, ${backup.key}`;
    if (backup.bytes) text += ` (${size(backup.bytes)})`;
    if (age > BACKUP_OVERDUE_MS) text += ", overdue: backups should run every hour";
    result.push(text);
  }

  if (memory.maxmemory && memory.used / memory.maxmemory >= MEMORY_WARNING) {
    result.push(
      `Memory is getting close to the limit: [increasing the Redis server size](${RESIZE_URL})`
    );
  }

  return result;
}

async function main(callback, deps = {}) {
  let result;

  try {
    result = lines(await collect(deps));
  } catch (err) {
    // Redis down or an unexpected reply: say so and let the email go out.
    result = ["Unavailable: " + String((err && err.message) || err).slice(0, 200)];
  }

  callback(null, { redis_server: result });
}

module.exports = main;
module.exports.collect = collect;
module.exports.lines = lines;
module.exports.parseBackup = parseBackup;
module.exports.BACKUP_KEY = BACKUP_KEY;
module.exports.RESIZE_URL = RESIZE_URL;

if (require.main === module) require("./cli")(main);
