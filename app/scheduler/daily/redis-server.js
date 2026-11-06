// The Redis and Server lines of the daily email (blotcms/blot#2041):
//
//   Redis: memory 27% (resize in ~58 days, 8 GB free), saved 3m ago, backed up 30m ago, offsite 9h ago
//   Server: disk 21% (stable, 19 GB free), RAM 75% available (12 GB)
//
// The storage bucket's line is daily/storage.js.
//
// The server is the host Redis runs on, which is also the app's since #2261.
// Redis tells us its own memory and last save, but only the Redis host can
// read its disk and its RAM: config/redis/bin/tcpmem-log.sh stores that in its 5-minute
// sample (SAMPLE_KEY), and config/redis/bin/backup.sh stores each upload in
// BACKUP_KEY (and each daily offsite one in OFFSITE_KEY). The trends come from the last week of daily readings of each
// (daily/trend.js), stored at MEMORY_HISTORY_KEY and DISK_HISTORY_KEY. Anything that needs attention is bold;
// missing or stale data is said so. This never fails the rest of the email.
const {
  parseSample,
  parseMemory,
  parseInfo,
  parseBackup,
  SAMPLE_KEY,
  BACKUP_KEY,
  OFFSITE_KEY,
} = require("../check-redis-host");
const trend = require("./trend");

// JSON [{ time, used, scope? }] of the daily runs (daily/trend.js), no TTL. The
// disk history is scoped to the host, since a replacement host starts afresh.
const MEMORY_HISTORY_KEY = "blot:redis-host:daily-memory-history";
const DISK_HISTORY_KEY = "blot:redis-host:daily-disk-history";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Before check-redis-host.js's MAXMEMORY_ALERT (90%): 80% of maxmemory still
// leaves room, and the first step is usually raising maxmemory, not a host cycle.
const MEMORY_WARNING = 0.8;
const RESIZE_URL =
  "https://github.com/blotcms/blot/blob/master/config/redis/README.md#increasing-the-redis-server-size";

// The host's available RAM, as a fraction of its total, below which the line
// calls it out (check-redis-host.js emails at HOST_MEMORY_ALERT).
const HOST_RAM_WARNING = 0.15;

// The host samples every 5 minutes (see check-redis-host.js's STALE_MS).
const SAMPLE_STALE_MS = 20 * MINUTE;
// Backups are hourly (the daily one is a second upload at 03:05).
const BACKUP_OVERDUE_MS = 2 * HOUR;
// The offsite copy is daily; allow one missed day.
const OFFSITE_OVERDUE_MS = 2 * DAY;
// The instance store holding local backup copies.
const BACKUP_DISK_FULL = 0.8;
// The root disk's trend projects to this, as memory does to MEMORY_WARNING.
const DISK_WARNING = 0.8;

const { size } = trend;
const percent = (fraction) => Math.round(fraction * 100) + "%";

const { compact } = trend;

// Everything the line needs, from Redis. client.sendCommand keeps these off
// the client-side cache: the host writes them from another client.
async function collect({
  client = require("models/client"),
  now = Date.now(),
} = {}) {
  const [
    info,
    sampleValue,
    backupValue,
    offsiteValue,
    memoryHistory,
    diskHistory,
  ] = await Promise.all([
    client.sendCommand(["INFO"]),
    client.sendCommand(["GET", SAMPLE_KEY]),
    client.sendCommand(["GET", BACKUP_KEY]),
    client.sendCommand(["GET", OFFSITE_KEY]),
    client.sendCommand(["GET", MEMORY_HISTORY_KEY]),
    client.sendCommand(["GET", DISK_HISTORY_KEY]),
  ]);
  const fields = parseInfo(info);

  return {
    now,
    memory: parseMemory(info),
    save: parseSave(fields),
    sample: parseSample(sampleValue),
    backup: parseBackup(backupValue),
    offsite:
      offsiteValue === null || offsiteValue === undefined
        ? undefined
        : parseBackup(offsiteValue),
    memoryHistory: trend.parse(memoryHistory),
    diskHistory: trend.parse(diskHistory),
  };
}

// INFO persistence
function parseSave(fields) {
  if (!fields.rdb_last_bgsave_status) return null;

  const saved = Number(fields.rdb_last_save_time);
  return {
    status: fields.rdb_last_bgsave_status,
    time: saved > 0 ? saved * 1000 : null,
  };
}

function memoryPart({ now, memory, memoryHistory }) {
  if (!memory.maxmemory) return `memory ${size(memory.used)}, no maxmemory set`;

  const limit = memory.maxmemory * MEMORY_WARNING;
  return (
    "memory " +
    trend.status({
      percent: percent(memory.used / memory.maxmemory),
      free: memory.maxmemory - memory.used,
      trend: trend.trend({
        history: memoryHistory,
        now,
        used: memory.used,
        limit,
        over: `**[resize now](${RESIZE_URL})**`,
      }),
    })
  );
}

// df's Available column when the host sent it (it excludes blocks reserved for
// root), else total - used. Fullness is used / (used + available), as df's own
// Use% is.
const free = ({ used, total, available }) =>
  available === null ? total - used : available;
const capacity = ({ used, total, available }) =>
  available === null ? total : used + available;
const fullness = ({ used, total, available }) =>
  available === null ? used / total : 1 - available / (used + available);

// The root disk, from the host's sample, and the instance store only if it
// needs attention.
function diskPart({ now, sample, diskHistory }) {
  if (!sample) return "no sample from the host";

  const age = now - sample.time;
  if (age > SAMPLE_STALE_MS) return `sample ${compact(age)} old`;
  if (!sample.diskRoot) return "disk not reported";

  let text =
    "disk " +
    trend.status({
      percent: percent(fullness(sample.diskRoot)),
      free: free(sample.diskRoot),
      trend: trend.trend({
        history: diskHistory,
        now,
        used: sample.diskRoot.used,
        limit: capacity(sample.diskRoot) * DISK_WARNING,
        scope: sample.host,
        over: "**resize now**",
      }),
    });

  if (!sample.diskBackups) text += ", **/backups not mounted**";
  else if (fullness(sample.diskBackups) >= BACKUP_DISK_FULL) {
    text += `, **backup disk ${percent(fullness(sample.diskBackups))} full**`;
  }
  return text;
}

// Available RAM of the host that took the sample (the Redis host, which is the
// app host too), not of the machine running this email.
function ramPart({ now, sample }) {
  if (!sample || now - sample.time > SAMPLE_STALE_MS) return null;
  if (!sample.ramTotal || sample.ramAvailable === null)
    return "RAM not reported";

  const fraction = sample.ramAvailable / sample.ramTotal;
  const text = `RAM ${percent(fraction)} available (${size(sample.ramAvailable)})`;
  return fraction < HOST_RAM_WARNING ? `**${text}**` : text;
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

// Nothing if offsite was never recorded, so hosts without it don't alert.
function offsitePart({ now, offsite }) {
  if (offsite === undefined) return null;
  if (!offsite) return "**offsite backup unreadable**";

  const age = now - offsite.time;
  return age > OFFSITE_OVERDUE_MS
    ? `**last offsite backup ${compact(age)} ago, overdue**`
    : `offsite ${compact(age)} ago`;
}

const join = (parts) => parts.filter(Boolean).join(", ");

// Turns collect()'s data into the two lines of the email.
function lines(data) {
  return {
    redis:
      "Redis: " +
      join([
        memoryPart(data),
        savePart(data),
        backupPart(data),
        offsitePart(data),
      ]),
    server: "Server: " + join([diskPart(data), ramPart(data)]),
  };
}

// Tomorrow's trends start from today's readings. The disk's only count when
// the host's sample is fresh.
async function saveHistory(
  { now, memory, memoryHistory, sample, diskHistory },
  deps
) {
  const client = deps.client || require("models/client");

  await trend.save(client, MEMORY_HISTORY_KEY, memoryHistory, {
    time: now,
    used: memory.used,
  });

  if (sample && sample.diskRoot && now - sample.time <= SAMPLE_STALE_MS) {
    await trend.save(client, DISK_HISTORY_KEY, diskHistory, {
      time: now,
      used: sample.diskRoot.used,
      scope: sample.host,
    });
  }
}

async function main(deps = {}) {
  let result;

  try {
    const data = await collect(deps);
    result = lines(data);
    await saveHistory(data, deps);
  } catch (err) {
    // Redis down or an unexpected reply: say so and let the email go out. The
    // server's sample is read from Redis, so it is unavailable too.
    const reason = String((err && err.message) || err)
      .replace(/[*`<>[\]]/g, "")
      .slice(0, 80);
    result = {
      redis: `Redis: unavailable (${reason})`,
      server: "Server: unavailable (its sample is read from Redis)",
    };
  }

  return result;
}

module.exports = main;
module.exports.collect = collect;
module.exports.lines = lines;
module.exports.parseBackup = parseBackup; // from check-redis-host.js
module.exports.BACKUP_KEY = BACKUP_KEY;
module.exports.OFFSITE_KEY = OFFSITE_KEY;
module.exports.MEMORY_HISTORY_KEY = MEMORY_HISTORY_KEY;
module.exports.DISK_HISTORY_KEY = DISK_HISTORY_KEY;
module.exports.RESIZE_URL = RESIZE_URL;

if (require.main === module) require("./cli")(main);
