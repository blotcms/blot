// The "Redis server" lines of the daily email (blotcms/blot#2041): memory and
// how fast it grows, disk space, the last save and backup, and a nudge to
// resize the host before it fills.
//
// Redis tells us its own memory, but only the Redis host can read its RAM and
// disk: config/redis/bin/tcpmem-log.sh stores those in its 5-minute sample
// (SAMPLE_KEY), and config/redis/bin/backup.sh stores each upload in
// BACKUP_KEY. The growth trend compares with the snapshot the previous daily
// run stored at SNAPSHOT_KEY. Missing or stale data is said so in the email;
// it never fails the rest of it.
const prettySize = require("helper/prettySize");
const { parseSample, parseMemory, parseInfo, SAMPLE_KEY } = require("../check-redis-host");

const BACKUP_KEY = "blot:redis-host:backup";
// JSON { time, keys, memory } of the last daily run, no TTL
const SNAPSHOT_KEY = "blot:redis-host:daily-snapshot";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// check-redis-host.js emails at 80%; the daily email points at the README a
// bit earlier, since a bigger host takes a few days to plan.
const MEMORY_WARNING = 0.7;
const RESIZE_URL =
  "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size";

// A snapshot closer than this to the last one is no basis for a daily trend
// (and does not replace it).
const MIN_TREND_GAP_MS = HOUR;
// Gaps within this of a day are shown as "in 24h"; others are scaled to a day.
const DAY_MS = 24 * HOUR;
const DAY_TOLERANCE_MS = 2 * HOUR;
// Beyond this the projection is noise.
const MAX_PROJECTION_DAYS = 730;

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

// INFO persistence. rdb_last_bgsave_time_sec is -1 and latest_fork_usec 0
// until the first save or fork.
function parseSave(fields) {
  if (!fields.rdb_last_bgsave_status) return null;

  const seconds = Number(fields.rdb_last_bgsave_time_sec);
  const fork = Number(fields.latest_fork_usec);
  const saved = Number(fields.rdb_last_save_time);
  const changes = Number(fields.rdb_changes_since_last_save);

  return {
    status: fields.rdb_last_bgsave_status,
    time: saved > 0 ? saved * 1000 : null,
    seconds: seconds >= 0 ? seconds : null,
    forkMs: fork > 0 ? fork / 1000 : null,
    changes: changes >= 0 ? changes : null,
  };
}

function parseSnapshot(value) {
  try {
    const { time, keys, memory } = JSON.parse(value);
    return time > 0 && keys >= 0 && memory >= 0 ? { time, keys, memory } : null;
  } catch (e) {
    return null;
  }
}

const disk = (label, { used, total }) =>
  `${label} ${size(used)} of ${size(total)} used (${percent(used / total)})`;

const commas = (n) => Math.round(n).toLocaleString("en-US");
const signed = (n, format) => (n < 0 ? "-" : "+") + format(Math.abs(n));
const millis = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");

function saveLine({ now, save }) {
  if (!save) return "Last save: not reported by Redis";

  const parts = [save.status === "ok" ? "ok" : `FAILED (${save.status}), Redis refuses writes until a save succeeds`];
  if (save.time) parts.push(ago(now - save.time));
  if (save.seconds !== null) parts.push(`took ${save.seconds}s`);
  if (save.forkMs) parts.push(`fork ${millis(save.forkMs)}`);
  if (save.changes !== null) parts.push(`${commas(save.changes)} changes since`);
  return "Last save: " + parts.join(", ");
}

// Keys and memory now, the change since the previous daily run (scaled to a
// day if it was not about one) and, at that rate, when memory reaches
// MEMORY_WARNING of maxmemory.
function growthLine({ now, memory, keys, snapshot }) {
  const current = `${commas(keys)} keys, ${size(memory.used)} memory`;
  if (!snapshot) return `Growth: ${current}; first snapshot, trend from tomorrow`;

  const gap = now - snapshot.time;
  if (gap < MIN_TREND_GAP_MS) return `Growth: ${current}; the previous snapshot is too recent for a trend`;

  const scale = Math.abs(gap - DAY_MS) <= DAY_TOLERANCE_MS ? 1 : DAY_MS / gap;
  const label = scale === 1 ? "in 24h" : `per day, over ${Math.round(gap / HOUR)}h`;
  const keysChange = (keys - snapshot.keys) * scale;
  const memoryChange = (memory.used - snapshot.memory) * scale;

  let text =
    `Growth: ${commas(keys)} keys (${signed(keysChange, commas)} ${label}), ` +
    `${size(memory.used)} memory (${signed(memoryChange, size)} ${label})`;

  const target = memory.maxmemory * MEMORY_WARNING;
  if (memoryChange > 0 && memory.maxmemory && memory.used < target) {
    const days = (target - memory.used) / memoryChange;
    text +=
      days > MAX_PROJECTION_DAYS
        ? `; at this rate ${percent(MEMORY_WARNING)} of maxmemory is more than 2 years away`
        : `; at this rate ${percent(MEMORY_WARNING)} of maxmemory in ~${Math.max(1, Math.round(days))} days`;
  }
  return text;
}

// Turns collect()'s data into the lines of the email, as markdown.
function lines({ now, memory, keys = 0, save = null, snapshot = null, sample, backup }) {
  const result = [];
  const stale = sample && now - sample.time > SAMPLE_STALE_MS;

  // Memory. This is the figure check-redis-host.js alerts on: used_memory
  // less replica output buffers.
  let text = memory.maxmemory
    ? `Memory: ${size(memory.used)} used of ${size(memory.maxmemory)} maxmemory (${percent(memory.used / memory.maxmemory)})`
    : `Memory: ${size(memory.used)} used, no maxmemory set`;
  text += sample && sample.ramTotal ? `, ${size(sample.ramTotal)} RAM on the host` : ", host RAM unknown";
  result.push(text);

  result.push(growthLine({ now, memory, keys, snapshot }));

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

  result.push(saveLine({ now, save }));

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

// Tomorrow's trend starts from today's figures. A failure to store them only
// costs tomorrow's trend. A manual re-run within the hour leaves the real
// previous snapshot alone.
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
    result = lines(data);
    await saveSnapshot(data, deps);
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
module.exports.SNAPSHOT_KEY = SNAPSHOT_KEY;
module.exports.RESIZE_URL = RESIZE_URL;

if (require.main === module) require("./cli")(main);
