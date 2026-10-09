// The Redis server line of the daily email (blotcms/blot#2041), one line:
//
//   Redis server: memory 27% (resize in ~47 days), disk 21% (19 GB free), saved 3m ago, backed up 30m ago
//
// Redis tells us its own memory and last save, but only the Redis host can
// read its disk: config/redis/bin/tcpmem-log.sh stores that in its 5-minute
// sample (SAMPLE_KEY), and config/redis/bin/backup.sh stores each upload in
// BACKUP_KEY. The resize projection compares with the snapshot the previous
// daily run stored at SNAPSHOT_KEY. Anything that needs attention is bold;
// missing or stale data is said so. This never fails the rest of the email.
const prettySize = require("helper/prettySize");
const { parseSample, parseMemory, parseInfo, SAMPLE_KEY } = require("../check-redis-host");

const BACKUP_KEY = "blot:redis-host:backup";
// JSON { time, keys, memory } of the last daily run, no TTL
const SNAPSHOT_KEY = "blot:redis-host:daily-snapshot";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// check-redis-host.js emails at 80%; the daily email says to resize a bit
// earlier, since a bigger host takes a few days to plan.
const MEMORY_WARNING = 0.7;
const RESIZE_URL =
  "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size";

// A snapshot closer than this to the last one is no basis for a daily trend
// (and does not replace it).
const MIN_TREND_GAP_MS = HOUR;
// Growth slower than this, or none, is "stable".
const STABLE_DAYS = 365;

// The host samples every 5 minutes (see check-redis-host.js's STALE_MS).
const SAMPLE_STALE_MS = 20 * MINUTE;
// Backups are hourly (the daily one is a second upload at 03:05).
const BACKUP_OVERDUE_MS = 2 * HOUR;
// The instance store holding local backup copies.
const BACKUP_DISK_FULL = 0.8;

// prettySize takes kilobytes, 1000 to the unit, and divides by 1024.
const size = (bytes) => prettySize(bytes / 1000, 1);
const percent = (fraction) => Math.round(fraction * 100) + "%";

// "3m", "2h", "3d"
function compact(ms) {
  if (ms < HOUR) return Math.max(0, Math.round(ms / MINUTE)) + "m";
  if (ms < 48 * HOUR) return Math.round(ms / HOUR) + "h";
  return Math.round(ms / DAY) + "d";
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

// Everything the line needs, from Redis. client.sendCommand keeps these off
// the client-side cache: the host writes them from another client.
async function collect({ client = require("models/client"), now = Date.now() } = {}) {
  const [info, sampleValue, backupValue, snapshotValue] = await Promise.all([
    client.sendCommand(["INFO"]),
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", BACKUP_KEY]),
    client.sendCommand(["GET", SNAPSHOT_KEY]),
  ]);
  const fields = parseInfo(info);

  return {
    now,
    memory: parseMemory(info),
    keys: keyCount(fields),
    save: parseSave(fields),
    sample: parseSample(sampleValue),
    backup: parseBackup(backupValue),
    snapshot: parseSnapshot(snapshotValue),
  };
}

// db0:keys=1204,expires=3,avg_ttl=0 (and any other databases)
function keyCount(fields) {
  return Object.keys(fields)
    .filter((name) => /^db\d+$/.test(name))
    .reduce((sum, name) => {
      const match = /keys=(\d+)/.exec(fields[name]);
      return sum + (match ? Number(match[1]) : 0);
    }, 0);
}

// INFO persistence
function parseSave(fields) {
  if (!fields.rdb_last_bgsave_status) return null;

  const saved = Number(fields.rdb_last_save_time);
  return { status: fields.rdb_last_bgsave_status, time: saved > 0 ? saved * 1000 : null };
}

function parseSnapshot(value) {
  try {
    const { time, keys, memory } = JSON.parse(value);
    return time > 0 && keys >= 0 && memory >= 0 ? { time, keys, memory } : null;
  } catch (e) {
    return null;
  }
}

// "(resize in ~47 days)" from how much memory grew since the previous daily
// run, scaled to a day, or "(stable)". Nothing without a usable snapshot.
function projection({ now, memory, snapshot }) {
  if (!snapshot || now - snapshot.time < MIN_TREND_GAP_MS) return "";

  const perDay = ((memory.used - snapshot.memory) * DAY) / (now - snapshot.time);
  const days = (memory.maxmemory * MEMORY_WARNING - memory.used) / perDay;

  if (!(perDay > 0) || days > STABLE_DAYS) return " (stable)";
  return ` (resize in ~${Math.max(1, Math.round(days))} days)`;
}

function memoryPart({ now, memory, snapshot }) {
  if (!memory.maxmemory) return `memory ${size(memory.used)}, no maxmemory set`;

  const fraction = memory.used / memory.maxmemory;
  if (fraction >= MEMORY_WARNING) return `memory ${percent(fraction)}, **[resize now](${RESIZE_URL})**`;
  return `memory ${percent(fraction)}${projection({ now, memory, snapshot })}`;
}

// df's Available column when the host sent it (it excludes blocks reserved for
// root), else total - used. Fullness is used / (used + available), as df's own
// Use% is.
const free = ({ used, total, available }) => (available === null ? total - used : available);
const fullness = ({ used, total, available }) =>
  available === null ? used / total : 1 - available / (used + available);

// The root disk, from the host's sample, and the instance store only if it
// needs attention.
function diskPart({ now, sample }) {
  if (!sample) return "no sample from the Redis host";

  const age = now - sample.time;
  if (age > SAMPLE_STALE_MS) return `sample ${compact(age)} old`;
  if (!sample.diskRoot) return "disk not reported by the Redis host";

  let text = `disk ${percent(fullness(sample.diskRoot))} (${size(free(sample.diskRoot))} free)`;

  if (!sample.diskBackups) text += ", **/backups not mounted**";
  else if (fullness(sample.diskBackups) >= BACKUP_DISK_FULL) {
    text += `, **backup disk ${percent(fullness(sample.diskBackups))} full**`;
  }
  return text;
}

function savePart({ now, save }) {
  if (!save) return "save not reported";
  if (save.status !== "ok") return "**last save failed**";
  return save.time ? `saved ${compact(now - save.time)} ago` : "never saved";
}

function backupPart({ now, backup }) {
  if (!backup) return "**no backup recorded**";

  const age = now - backup.time;
  return age > BACKUP_OVERDUE_MS
    ? `**last backup ${compact(age)} ago, overdue**`
    : `backed up ${compact(age)} ago`;
}

// Turns collect()'s data into the line of the email.
function line(data) {
  return (
    "Redis server: " +
    [memoryPart(data), diskPart(data), savePart(data), backupPart(data)].join(", ")
  );
}

// Tomorrow's projection starts from today's figures. A failure to store them
// only costs tomorrow's projection. A manual re-run within the hour leaves the
// real previous snapshot alone.
async function saveSnapshot({ now, memory, keys, snapshot }, deps) {
  if (snapshot && now - snapshot.time < MIN_TREND_GAP_MS) return;

  try {
    const client = deps.client || require("models/client");
    await client.sendCommand(["SET", SNAPSHOT_KEY, JSON.stringify({ time: now, keys, memory: memory.used })]);
  } catch (err) {
    console.log("Daily update: could not store the Redis snapshot:", err.message);
  }
}

async function main(callback, deps = {}) {
  let result;

  try {
    const data = await collect(deps);
    result = line(data);
    await saveSnapshot(data, deps);
  } catch (err) {
    // Redis down or an unexpected reply: say so and let the email go out.
    const reason = String((err && err.message) || err).replace(/[*`<>[\]]/g, "").slice(0, 80);
    result = `Redis server: unavailable (${reason})`;
  }

  callback(null, { redis_server: result });
}

module.exports = main;
module.exports.collect = collect;
module.exports.line = line;
module.exports.parseBackup = parseBackup;
module.exports.BACKUP_KEY = BACKUP_KEY;
module.exports.SNAPSHOT_KEY = SNAPSHOT_KEY;
module.exports.RESIZE_URL = RESIZE_URL;

if (require.main === module) require("./cli")(main);
